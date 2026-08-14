// Optimized TRON encoder.
//
// Profiling the original showed where the 6x went (tabular-10k, JSON.stringify
// = 3.98ms baseline):
//     emit via array.push + join('')  15.24 ms   <-- dominant
//     shape scan (keys.join sig)       3.48 ms
//     dict statistics pass             1.89 ms
//     + a second shape-signature computation during emit (~6.5 ms)
// and that plain string concatenation emits the same output in 6.72 ms — V8
// ropes beat array-join here. Hand-rolled string quoting was *slower* than
// JSON.stringify, so quoting stays native.
//
// The big win is the REVERSE TRAMPOLINE, mirroring the decode side: project
// rows to plain arrays, let native JSON.stringify serialize them, then rewrite
// row brackets with native replaceAll:
//
//     [[1,"Ada"],[2,"Bob"]]   ->   [C0(1,"Ada"),C0(2,"Bob")]
//
// SAFETY. Two properties must hold for that text rewrite to be sound, and both
// are verified by counting on the serialized text rather than by inspecting
// every string value (cheaper, and exact):
//   1. `],[` occurs exactly rows-1 times. Every real row separator contributes
//      one, so any extra means a string contained the sequence.
//   2. `(` and `)` do not occur at all. Canonical TRON escapes parens inside
//      strings so the decoder can treat every raw paren as structural;
//      JSON.stringify does not escape them, so their absence must be checked.
// If either fails we fall back to the general encoder, which escapes properly.

import * as TBL from './tron-table.js';

const MIN_USES = 2;
// Shape-signature separator. MUST be identical everywhere a signature is built
// or looked up; a mismatch silently turns lookups into permanent misses.
const SIG_SEP = '\u0000';
const DICT_MAX_UNIQUES = 64;
const MIN_CHUNK = 8;   // below this a table declaration costs more than it saves

// ---------------------------------------------------------------- helpers
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isScalar(v) {
  return v === null || typeof v !== 'object';
}

// Field name may be bare in a class declaration only if a plain identifier.
function encFieldName(k) {
  if (k.length === 0) return JSON.stringify(k);
  const f = k.charCodeAt(0);
  if (!((f >= 65 && f <= 90) || (f >= 97 && f <= 122) || f === 95)) return JSON.stringify(k);
  for (let i = 1; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 46)) {
      return JSON.stringify(k);
    }
  }
  return k;
}

function encEnumVal(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v.length === 0 || v === 'true' || v === 'false' || v === 'null') return JSON.stringify(v);
  const f = v.charCodeAt(0), l = v.charCodeAt(v.length - 1);
  if (f === 32 || l === 32 || f === 9 || l === 9 || f === 34) return JSON.stringify(v);
  for (let k = 0; k < v.length; k++) {
    const c = v.charCodeAt(k);
    if (c === 44 || c === 34 || c === 92 || c < 32) return JSON.stringify(v);
  }
  if (!Number.isNaN(Number(v))) return JSON.stringify(v);
  return v;
}

// JSON string quoting + paren escaping (canonical TRON).
function encStr(str) {
  const j = JSON.stringify(str);
  if (str.indexOf('(') < 0 && str.indexOf(')') < 0) return j;
  let o = '';
  for (let k = 0; k < j.length; k++) {
    const c = j.charCodeAt(k);
    if (c === 40) o += '\\u0028';
    else if (c === 41) o += '\\u0029';
    else o += j[k];
  }
  return o;
}

function numStr(v) {
  return Number.isFinite(v) ? String(v) : 'null';
}

// count non-overlapping occurrences (native indexOf loop)
function countOcc(hay, needle) {
  let n = 0, i = 0;
  const step = needle.length;
  for (;;) {
    const p = hay.indexOf(needle, i);
    if (p === -1) return n;
    n++; i = p + step;
  }
}


// In table mode rows are serialized by JSON.stringify, which does not escape
// parens. Canonical TRON requires every RAW paren in a document to be
// structural (the trampoline relies on it), so escape them here. In plain JSON
// a paren can only occur inside a string, so a blanket replace is safe and the
// result is still valid JSON (\u0028 decodes back to "(").
function escapeParens(t) {
  if (t.indexOf('(') === -1 && t.indexOf(')') === -1) return t;
  return t.replaceAll('(', '\\u0028').replaceAll(')', '\\u0029');
}

// ---------------------------------------------------------------- fast path
// Root array of >=2 uniform, flat objects. Returns undefined if inapplicable.
function tryFastTable(value, useDict, useTable, useTableNested) {
  if (!Array.isArray(value)) return undefined;
  const n = value.length;
  if (n < MIN_USES) return undefined;
  const r0 = value[0];
  if (!isPlainObject(r0)) return undefined;
  const keys = Object.keys(r0);
  const nf = keys.length;
  if (nf === 0) return undefined;

  // Pass 1 — verify uniform + flat, and gather dictionary statistics.
  const stats = useDict ? new Array(nf) : null;
  if (useDict) for (let k = 0; k < nf; k++) stats[k] = { m: new Map(), ok: true, total: 0, bytes: 0, kind: undefined };

  for (let i = 0; i < n; i++) {
    const r = value[i];
    if (!isPlainObject(r)) return undefined;
    const rk = Object.keys(r);
    if (rk.length !== nf) return undefined;
    for (let k = 0; k < nf; k++) if (rk[k] !== keys[k]) return undefined;
    for (let k = 0; k < nf; k++) {
      const v = r[keys[k]];
      // In table mode rows are plain JSON arrays, so a nested object/array is
      // fine — it just serializes as JSON. Outside table mode a nested value
      // would need the text transform, so it goes to the general path.
      // Nested values are only allowed when the caller opts into nested tables:
      // they serialize as plain JSON, which costs the token savings those inner
      // shapes would have got from their own class. Flat rows are a pure win.
      // Objects with toJSON (Dates) are fine: rows are serialized by native
      // JSON.stringify further down, which resolves them exactly like JSON.
      if (!isScalar(v) && typeof v.toJSON !== 'function' && !useTableNested) return undefined;
      if (useDict) {
        const st = stats[k];
        if (!st.ok) continue;
        const vt = typeof v;
        if (vt !== 'string' && vt !== 'boolean') { st.ok = false; st.m = null; continue; }
        if (st.kind === undefined) st.kind = vt;
        else if (st.kind !== vt) { st.ok = false; st.m = null; continue; }
        st.total++; st.bytes += (vt === 'string' ? v.length : 5);
        const c = st.m.get(v);
        if (c === undefined) {
          if (st.m.size >= DICT_MAX_UNIQUES) { st.ok = false; st.m = null; continue; }
          st.m.set(v, 1);
        } else st.m.set(v, c + 1);
      }
    }
  }

  // Decide dictionaries.
  let dictMaps = null;
  const enumDecls = [];
  const declFields = new Array(nf);
  const enumBySig = new Map();
  let en = 0;
  for (let k = 0; k < nf; k++) {
    declFields[k] = encFieldName(keys[k]);
    if (!useDict) continue;
    const st = stats[k];
    if (st.ok && st.m && st.m.size >= 1 && n >= 3 * st.m.size && st.total > 0 && (st.bytes / st.total) >= 2) {
      const values = Array.from(st.m.keys());
      const vsig = JSON.stringify(values);
      let ename = enumBySig.get(vsig);
      if (ename === undefined) {
        ename = 'E' + (en++);
        enumBySig.set(vsig, ename);
        enumDecls.push('enum ' + ename + ': ' + values.map(encEnumVal).join(','));
      }
      if (!dictMaps) dictMaps = new Array(nf).fill(null);
      const idx = new Map();
      for (let q = 0; q < values.length; q++) idx.set(values[q], q);
      dictMaps[k] = idx;
      declFields[k] = encFieldName(keys[k]) + '@' + ename;
    }
  }

  const header = (enumDecls.length ? enumDecls.join('\n') + '\n' : '') +
    'class C0: ' + declFields.join(',') + '\n';

  // Pass 2 — project to plain arrays so native JSON.stringify can serialize.
  const proj = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = value[i];
    const a = new Array(nf);
    if (dictMaps === null) {
      for (let k = 0; k < nf; k++) a[k] = r[keys[k]];
    } else {
      for (let k = 0; k < nf; k++) {
        const dm = dictMaps[k];
        a[k] = dm === null ? r[keys[k]] : dm.get(r[keys[k]]);
      }
    }
    proj[i] = a;
  }

  const t = JSON.stringify(proj);

  // TABLE MODE: rows stay plain JSON arrays and a `table` declaration says
  // where they live. The decoder then needs no text transform at all — and the
  // repeated class name disappears from every row, so tokens drop too.
  if (useTable) return header + 'table C0: $\n' + escapeParens(t);

  // Soundness checks on the serialized text (see header comment).
  if (t.indexOf('(') !== -1 || t.indexOf(')') !== -1) return undefined;
  if (countOcc(t, '],[') !== n - 1) return undefined;

  // [[a,b],[c,d]] -> [C0(a,b),C0(c,d)]
  const body = '[C0(' + t.slice(2, t.length - 2).replaceAll('],[', '),C0(') + ')]';
  return header + body;
}

// ---------------------------------------------------------------- general
// Same semantics as before, but emitting with string concatenation rather than
// array push + join (measured 2.3x faster on the emit phase).
function stringifyGeneral(value, useDict, useTable, useTableNested) {
  const tableDecls = [];
  let curPath = '$';   // path of the value currently being emitted (null = unaddressable)
  const shapeCounts = new Map();
  // Arrays proven uniform+flat during the scan; the emit phase reuses this
  // proof instead of walking every row's keys a second time.
  const uniformArrays = new WeakMap();

  // A run of identical flat rows shares ONE signature: compute keys.join once
  // for the whole array instead of once per row, and skip recursing into rows
  // whose values are all scalars. On a 10k-row array that removes 10k string
  // joins and 10k recursive calls.
  function scanUniformArray(arr) {
    const n = arr.length;
    if (n < MIN_USES) return false;
    const r0 = arr[0];
    if (r0 === null || typeof r0 !== 'object' || Array.isArray(r0)) return false;
    const keys = Object.keys(r0);
    const nf = keys.length;
    if (nf === 0) return false;
    for (let i = 0; i < n; i++) {
      const r = arr[i];
      if (r === null || typeof r !== 'object' || Array.isArray(r)) return false;
      const rk = Object.keys(r);
      if (rk.length !== nf) return false;
      for (let k = 0; k < nf; k++) if (rk[k] !== keys[k]) return false;
      if (!(useTableNested && n >= MIN_CHUNK)) {
        for (let k = 0; k < nf; k++) { const val = r[keys[k]]; if (val !== null && typeof val === 'object' && typeof val.toJSON !== 'function') return false; }
      }
    }
    const sig = keys.join(SIG_SEP);
    let e = shapeCounts.get(sig);
    if (!e) {
      e = { count: 0, keys, stats: null, cls: null };
      if (useDict) {
        e.stats = new Array(nf);
        for (let k = 0; k < nf; k++) e.stats[k] = { m: new Map(), ok: true, total: 0, bytes: 0, kind: undefined };
      }
      shapeCounts.set(sig, e);
    }
    e.count += n;
    if (useDict) {
      for (let i = 0; i < n; i++) {
        const r = arr[i];
        for (let k = 0; k < nf; k++) {
          const st = e.stats[k];
          if (!st.ok) continue;
          const val = r[keys[k]];
          const vt = typeof val;
          if (vt !== 'string' && vt !== 'boolean') { st.ok = false; st.m = null; continue; }
          if (st.kind === undefined) st.kind = vt;
          else if (st.kind !== vt) { st.ok = false; st.m = null; continue; }
          st.total++; st.bytes += (vt === 'string' ? val.length : 5);
          const c = st.m.get(val);
          if (c === undefined) {
            if (st.m.size >= DICT_MAX_UNIQUES) { st.ok = false; st.m = null; continue; }
            st.m.set(val, 1);
          } else st.m.set(val, c + 1);
        }
      }
    }
    uniformArrays.set(arr, keys);
    return true;
  }

  (function scan(v) {
    if (v === null || typeof v !== 'object') return;
    // JSON.stringify semantics: an object with toJSON serializes as its
    // toJSON() result (Dates -> ISO strings), so scan the resolved value.
    if (typeof v.toJSON === 'function') { scan(v.toJSON()); return; }
    if (Array.isArray(v)) {
      if (scanUniformArray(v)) return;
      for (let k = 0; k < v.length; k++) scan(v[k]);
      return;
    }
    const keys = Object.keys(v);
    const sig = keys.join(SIG_SEP);
    let e = shapeCounts.get(sig);
    if (!e) {
      e = { count: 0, keys, stats: null, cls: null };
      if (useDict) {
        e.stats = new Array(keys.length);
        for (let k = 0; k < keys.length; k++) e.stats[k] = { m: new Map(), ok: true, total: 0, bytes: 0, kind: undefined };
      }
      shapeCounts.set(sig, e);
    }
    e.count++;
    if (useDict) {
      const keysL = keys.length;
      for (let k = 0; k < keysL; k++) {
        const st = e.stats[k];
        if (!st.ok) continue;
        const val = v[keys[k]];
        const vt = typeof val;
        if (vt !== 'string' && vt !== 'boolean') { st.ok = false; st.m = null; continue; }
        if (st.kind === undefined) st.kind = vt;
        else if (st.kind !== vt) { st.ok = false; st.m = null; continue; }
        st.total++; st.bytes += (vt === 'string' ? val.length : 5);
        const c = st.m.get(val);
        if (c === undefined) {
          if (st.m.size >= DICT_MAX_UNIQUES) { st.ok = false; st.m = null; continue; }
          st.m.set(val, 1);
        } else st.m.set(val, c + 1);
      }
    }
    for (let k = 0; k < keys.length; k++) scan(v[keys[k]]);
  })(value);

  const classDecls = [];
  const enumDecls = [];
  const enumBySig = new Map();
  let cn = 0, en = 0;
  for (const e of shapeCounts.values()) {
    if (e.count >= MIN_USES && e.keys.length > 0) {
      const name = 'C' + (cn++);
      let dictMaps = null;
      const declFields = new Array(e.keys.length);
      for (let k = 0; k < e.keys.length; k++) {
        declFields[k] = encFieldName(e.keys[k]);
        if (!useDict) continue;
        const st = e.stats[k];
        if (st.ok && st.m && st.m.size >= 1 &&
            e.count >= 3 * st.m.size && st.total > 0 && (st.bytes / st.total) >= 2) {
          const values = Array.from(st.m.keys());
          const vsig = JSON.stringify(values);
          let ename = enumBySig.get(vsig);
          if (ename === undefined) {
            ename = 'E' + (en++);
            enumBySig.set(vsig, ename);
            enumDecls.push('enum ' + ename + ': ' + values.map(encEnumVal).join(','));
          }
          if (!dictMaps) dictMaps = new Array(e.keys.length).fill(null);
          const idx = new Map();
          for (let q = 0; q < values.length; q++) idx.set(values[q], q);
          dictMaps[k] = idx;
          declFields[k] = encFieldName(e.keys[k]) + '@' + ename;
        }
      }
      e.cls = { name, keys: e.keys, dictMaps };
      classDecls.push('class ' + name + ': ' + declFields.join(','));
    }
  }

  // Apply the reverse trampoline to any sufficiently long run of uniform flat
  // rows found anywhere in the tree — this is what makes the common API
  // envelope {meta:{...}, data:[...10k rows]} fast, since its root is an object
  // and so misses the top-level fast path. Returns null when inapplicable.
  function tryRowChunk(arr) {
    const n = arr.length;
    if (n < MIN_CHUNK) return null;
    // The scan already proved uniformity + flatness for this exact array.
    const keys = uniformArrays.get(arr);
    if (keys === undefined) return null;
    const nf = keys.length;
    const e = shapeCounts.get(keys.join(SIG_SEP));
    const cls = e && e.cls;
    if (!cls) return null;
    const dm = cls.dictMaps;
    const proj = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = arr[i];
      const a = new Array(nf);
      if (dm === null) { for (let k = 0; k < nf; k++) a[k] = r[keys[k]]; }
      else {
        for (let k = 0; k < nf; k++) {
          const dmk = dm[k];
          a[k] = dmk === null ? r[keys[k]] : dmk.get(r[keys[k]]);
        }
      }
      proj[i] = a;
    }
    const t = JSON.stringify(proj);
    if (useTable && curPath !== null) {
      if (t.length === 0) return null;
      tableDecls.push('table ' + cls.name + ': ' + curPath);
      return escapeParens(t);         // plain JSON rows; decoder needs no transform
    }
    if (t.indexOf('(') !== -1 || t.indexOf(')') !== -1) return null;
    if (countOcc(t, '],[') !== n - 1) return null;
    const open = cls.name + '(';
    return '[' + open + t.slice(2, t.length - 2).replaceAll('],[', '),' + open) + ')]';
  }

  let out = '';
  function enc(v) {
    if (v === null) { out += 'null'; return; }
    const t = typeof v;
    if (t === 'string') { out += encStr(v); return; }
    if (t === 'number') { out += numStr(v); return; }
    if (t === 'boolean') { out += v ? 'true' : 'false'; return; }
    if (t === 'undefined') { out += 'null'; return; }
    if (typeof v.toJSON === 'function' && t !== 'function') { enc(v.toJSON()); return; }
    if (Array.isArray(v)) {
      const chunk = tryRowChunk(v);
      if (chunk !== null) { out += chunk; return; }
      const base = curPath;
      out += '[';
      for (let k = 0; k < v.length; k++) {
        if (k) out += ',';
        curPath = base === null ? null : TBL.pathIndex(base, k);
        enc(v[k]);
      }
      curPath = base;
      out += ']';
      return;
    }
    const keys = Object.keys(v);
    const e = shapeCounts.get(keys.join(SIG_SEP));
    const cls = e && e.cls;
    if (cls) {
      out += cls.name + '(';
      const dm = cls.dictMaps;
      const ck = cls.keys;
      const base = curPath;
      for (let k = 0; k < ck.length; k++) {
        if (k) out += ',';
        const dmk = dm === null ? null : dm[k];
        if (dmk) out += dmk.get(v[ck[k]]);
        else { curPath = null; enc(v[ck[k]]); }   // inside an instantiation: not addressable
      }
      curPath = base;
      out += ')';
    } else {
      const base = curPath;
      out += '{';
      for (let k = 0; k < keys.length; k++) {
        if (k) out += ',';
        out += encStr(keys[k]) + ':';
        curPath = base === null ? null : TBL.pathKey(base, keys[k]);
        enc(v[keys[k]]);
      }
      curPath = base;
      out += '}';
    }
  }
  enc(value);

  if (classDecls.length === 0 && enumDecls.length === 0 && tableDecls.length === 0) return out;
  return enumDecls.concat(classDecls).concat(tableDecls).join('\n') + '\n' + out;
}

// opts.table:
//   true       -> table declarations for FLAT uniform rows only. Pure win:
//                 faster to decode AND fewer tokens than class instantiation.
//   'nested'   -> also table-ify rows containing nested objects/arrays. Faster
//                 still, but those inner shapes lose their own class savings,
//                 so tokens can get worse. Opt-in for a reason.
function stringify(value, opts) {
  const useDict = !!(opts && opts.dict);
  const useTableNested = !!(opts && opts.table === 'nested');
  const useTable = !!(opts && opts.table);
  if (!(opts && opts.noFastPath)) {
    const fast = tryFastTable(value, useDict, useTable, useTableNested);
    if (fast !== undefined) return fast;
  }
  return stringifyGeneral(value, useDict, useTable, useTableNested);
}

export { stringify, stringifyGeneral, tryFastTable };
