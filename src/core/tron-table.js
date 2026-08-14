// TABLE MODE — transform-free decoding.
//
// Profiling the remaining losses showed the decoder was paying for text
// rewriting it should not need. On the API envelope (10k rows) the budget was:
//     replaceAll x2            1.88 ms
//     JSON.parse(transformed)  3.88 ms
//     ambiguity guard          0.31 ms
//     walk + constructors      1.98 ms
// against a 6.63 ms JSON.parse baseline — only ~0.9 ms of headroom, so no
// amount of micro-tuning gets under 1.00x.
//
// The fix is to remove the transform rather than optimize it. The encoder
// declares WHERE each table lives:
//
//     enum E0: admin,user,editor
//     class C0: id,name,role@E0
//     table C0: $.data
//     {"meta":{...},"data":[[1,"Ada",0],[2,"Bob",1]]}
//
// Rows are plain JSON arrays, so the body is ordinary JSON. Decoding becomes
// JSON.parse + navigate + a compiled constructor loop: no replaceAll passes,
// no marker strings, and no ambiguity guard (the path says exactly which array
// is a table, so a look-alike array elsewhere can never be misread).
//
// This is an extension of TRON, like the `enum` dictionary — not part of the
// published format. It also *reduces* tokens, since the repeated class name
// disappears from every row.
//
// Path grammar: `$` for the root, then `.ident` for identifier-safe keys,
// `["quoted"]` for other keys, and `[123]` for array indices.

import { parsePrelude } from './tron.js';

// ---------------------------------------------------------------- paths
function isIdentKey(k) {
  if (k.length === 0) return false;
  const f = k.charCodeAt(0);
  if (!((f >= 65 && f <= 90) || (f >= 97 && f <= 122) || f === 95)) return false;
  for (let i = 1; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
}
function pathKey(base, key) {
  return base + (isIdentKey(key) ? '.' + key : '[' + JSON.stringify(key) + ']');
}
function pathIndex(base, i) { return base + '[' + i + ']'; }

// Parse a path into segments. Returns null if malformed.
function parsePath(p) {
  if (p.charCodeAt(0) !== 36 /* $ */) return null;
  const segs = [];
  let i = 1;
  const n = p.length;
  while (i < n) {
    const c = p.charCodeAt(i);
    if (c === 46 /* . */) {
      i++;
      const st = i;
      while (i < n) { const d = p.charCodeAt(i); if (d === 46 || d === 91) break; i++; }
      segs.push(p.slice(st, i));
    } else if (c === 91 /* [ */) {
      i++;
      if (p.charCodeAt(i) === 34 /* " */) {
        // quoted key — find the matching close quote, honouring escapes
        let out = '', seg = ++i;
        for (;;) {
          if (i >= n) return null;
          const d = p.charCodeAt(i);
          if (d === 34) { out += p.slice(seg, i); i++; break; }
          if (d === 92) { out += p.slice(seg, i); i++; out += p[i]; i++; seg = i; }
          else i++;
        }
        try { segs.push(JSON.parse('"' + out.replace(/"/g, '\\"') + '"')); }
        catch (e) { segs.push(out); }
        if (p.charCodeAt(i) !== 93) return null;
        i++;
      } else {
        const st = i;
        while (i < n && p.charCodeAt(i) !== 93) i++;
        if (i >= n) return null;
        segs.push(Number(p.slice(st, i)));
        i++;
      }
    } else return null;
  }
  return segs;
}

// ---------------------------------------------------------------- decode
// Compiled row constructors, cached across documents by shape.
const ctorCache = new Map();
function getCtor(fields, dictFlags, dicts) {
  const key = dictFlags.join('') + '|' + fields.join(',');
  let fac = ctorCache.get(key);
  if (!fac) {
    let body = 'return function(r){return {';
    for (let k = 0; k < fields.length; k++) {
      if (k) body += ',';
      body += JSON.stringify(fields[k]) + ':' + (dictFlags[k] === 1 ? ('D[' + k + '][r[' + k + ']]') : ('r[' + k + ']'));
    }
    body += '}}';
    fac = new Function('D', body);
    ctorCache.set(key, fac);
  }
  return fac(dicts);
}

// Returns the decoded value, or undefined if this document is not table-mode
// (or mixes tables with class instantiations, which needs the trampoline).
function decode(text, pre) {
  pre = pre || parsePrelude(text);
  const tables = pre.tables;
  if (!tables || tables.length === 0) return undefined;
  // The real precondition is simply "the body is plain JSON". A body that still
  // contains `Ck(...)` instantiations cannot parse as JSON, so JSON.parse
  // succeeding IS the proof — no separate bookkeeping needed, and it allows
  // documents that declare classes used only inside table rows.
  const body = text.slice(pre.end);
  let root;
  try { root = JSON.parse(body); } catch (e) { return undefined; }

  for (let t = 0; t < tables.length; t++) {
    const decl = tables[t];
    const cls = pre.classes[decl.cls];
    if (!cls) return undefined;
    const segs = parsePath(decl.path);
    if (segs === null) return undefined;

    // navigate to the parent container so the table can be replaced in place
    let parent = null, lastSeg = null, cur = root;
    for (let q = 0; q < segs.length; q++) {
      if (cur === null || typeof cur !== 'object') return undefined;
      parent = cur; lastSeg = segs[q]; cur = cur[segs[q]];
    }
    if (!Array.isArray(cur)) return undefined;

    const fields = cls.f, dicts = cls.d;
    const nf = fields.length;
    const dictFlags = new Array(nf);
    let hasDict = false;
    for (let k = 0; k < nf; k++) { dictFlags[k] = dicts[k] === null ? 0 : 1; if (dictFlags[k]) hasDict = true; }
    const ctor = getCtor(fields, dictFlags, hasDict ? dicts : null);

    const n = cur.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = cur[i];
      if (!Array.isArray(row) || row.length !== nf) return undefined;
      out[i] = ctor(row);
    }
    if (parent === null) root = out;
    else parent[lastSeg] = out;
  }
  return root;
}

export { decode, parsePath, pathKey, pathIndex, isIdentKey };
