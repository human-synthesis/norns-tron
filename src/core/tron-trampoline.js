// The JSON.parse TRAMPOLINE — the "innovative" decode path.
//
// Insight: JSON.parse is native C++, and V8's string replaceAll is also native
// C++. So instead of scanning TRON char-by-char in JS, we:
//
//   1. Rewrite class instantiations with native replaceAll (~GB/s).
//   2. Feed the result to JSON.parse (native C++).
//   3. Rebuild rows with per-class constructors compiled via new Function —
//      a monomorphic {k1:r[0],k2:r[1],...} literal that V8 turns into a single
//      hidden-class allocation. Dictionary columns bake the lookup into the
//      constructor: D[k][r[i]].
//
// JS never scans the payload character-by-character; it only orchestrates
// native passes and materializes objects.
//
// Two transform modes:
//   ANONYMOUS (single-class docs):  C0(a,b) -> [a,b]
//       JSON.parse allocates no marker string per row. Requires that no
//       instance is nested inside another — guarded by counting C0( against
//       the number of top-level rows.
//   MARKER (general):               C0(a,b) -> ["\u0001C0",a,b]
//       Handles multi-class and nested instances.
//
// Safe because canonical TRON escapes "(" and ")" inside strings (see encStr
// in tron.js), so every raw paren in the document is structural.
//
// Caveats: needs new Function (CSP-restricted environments fall back to
// parseFast); a literal U+0001 in the source falls back to the scanner.

import { parsePrelude, parseFast, applyTables } from './tron.js';

const MARK = '\u0001';
const MARK_ESC = '\\u0001'; // the 6-character JSON escape, not the raw char

// Path-coverage counters. Used by stress.js to prove the risky fast paths are
// actually exercised by the corpus rather than silently falling back.
const stats = {
  anonRoot: 0, anonDeep: 0, anonReject: 0, deepReject: 0,
  markerTight: 0, markerWalk: 0, plainJson: 0, fallbackScanner: 0, lazyRows: 0,
};

// ---- compiled-constructor cache (shared across calls) ----
// Dict *contents* are bound per-document via the outer function, so the
// compiled code itself is reusable across documents with the same shape.
const ctorFactoryCache = new Map();

function getCtorFactory(fields, dictFlags, offset) {
  const key = offset + '|' + dictFlags.join('') + '|' + fields.join(',');
  let fac = ctorFactoryCache.get(key);
  if (fac) return fac;
  let body = 'return function(r){return {';
  for (let k = 0; k < fields.length; k++) {
    if (k) body += ',';
    body += JSON.stringify(fields[k]) + ':';
    body += dictFlags[k] === 1 ? ('D[' + k + '][r[' + (k + offset) + ']]') : ('r[' + (k + offset) + ']');
  }
  body += '}}';
  fac = new Function('D', body);
  ctorFactoryCache.set(key, fac);
  return fac;
}

function buildCtors(classes, offset) {
  const ctors = Object.create(null);
  for (const name in classes) {
    const cls = classes[name];
    const dictFlags = cls.d.map(d => (d === null ? 0 : 1));
    ctors[name] = getCtorFactory(cls.f, dictFlags, offset)(cls.d);
  }
  return ctors;
}

// ---- lazy row classes (simdjson "On Demand" style) ----
const lazyClassCache = new Map();

function getLazyClass(fields, dictFlags, offset) {
  const key = offset + '|' + dictFlags.join('') + '|' + fields.join(',');
  let fac = lazyClassCache.get(key);
  if (fac) return fac;
  let body = 'return class{constructor(r){this._r=r}';
  for (let k = 0; k < fields.length; k++) {
    const fname = JSON.stringify(fields[k]);
    const expr = dictFlags[k] === 1
      ? ('D[' + k + '][this._r[' + (k + offset) + ']]')
      : ('this._r[' + (k + offset) + ']');
    body += 'get ' + fname + '(){return ' + expr + '}';
  }
  body += 'toJSON(){return {';
  for (let k = 0; k < fields.length; k++) {
    if (k) body += ',';
    body += JSON.stringify(fields[k]) + ':this[' + JSON.stringify(fields[k]) + ']';
  }
  body += '}}}';
  fac = new Function('D', body);
  lazyClassCache.set(key, fac);
  return fac;
}

// canonical class names C<digits> are safe for plain string replaceAll;
// arbitrary names need a boundary-guarded regex to avoid substring hits.
function isCanonicalName(n) {
  if (n.charCodeAt(0) !== 67 /* C */) return false;
  for (let k = 1; k < n.length; k++) { const c = n.charCodeAt(k); if (c < 48 || c > 57) return false; }
  return n.length > 1;
}

function transform(text, pre) {
  let t = text.slice(pre.end);
  const names = Object.keys(pre.classes);
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    // JSON forbids RAW control characters inside strings, so the marker must
    // be written as the escape sequence \u0001; JSON.parse decodes it back to
    // U+0001. Emitting it raw made JSON.parse throw, which silently killed
    // this entire path (every multi-class doc fell back to the scanner).
    const rep = '["' + MARK_ESC + name + '",';
    if (isCanonicalName(name)) {
      t = t.replaceAll(name + '(', rep);
    } else {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp('(?<![A-Za-z0-9_.])' + esc + '\\(', 'g'), rep);
    }
  }
  if (names.length > 0) t = t.replaceAll(')', ']');
  return t;
}

// A data string that itself begins with U+0001 would be indistinguishable from
// a marker after parsing. The encoder writes such a character as the escape
// \u0001, so BOTH forms must be checked.
function hasMarkerCollision(text) {
  return text.indexOf(MARK) !== -1 || text.indexOf(MARK_ESC) !== -1;
}

// Count non-overlapping occurrences using native indexOf (one linear scan).
function countOcc(hay, needle) {
  let n = 0, i = 0;
  const step = needle.length;
  for (;;) {
    const p = hay.indexOf(needle, i);
    if (p === -1) return n;
    n++; i = p + step;
  }
}

// ANONYMOUS fast path — returns undefined if not applicable.
function tryAnonymous(text, pre, name, lazy) {
  const body = text.slice(pre.end);
  // Cheap pre-check: this path only handles a root array of instances.
  // Without it we would pay a full transform + JSON.parse before finding out.
  if (body.charCodeAt(0) !== 91 /* [ */ || body.charCodeAt(1) !== name.charCodeAt(0)) return undefined;
  const open = name + '(';
  const t = body.replaceAll(open, '[').replaceAll(')', ']');
  let raw;
  try { raw = JSON.parse(t); } catch (e) { return undefined; }
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (countOcc(body, open) !== raw.length) { stats.anonReject++; return undefined; } // nested instances
  const cls = pre.classes[name];
  const nf = cls.f.length;
  const dictFlags = cls.d.map(d => (d === null ? 0 : 1));
  const out = new Array(raw.length);
  if (lazy) {
    const L = getLazyClass(cls.f, dictFlags, 0)(cls.d);
    for (let k = 0; k < raw.length; k++) {
      const row = raw[k];
      if (!Array.isArray(row) || row.length !== nf) { stats.anonReject++; return undefined; }
      out[k] = new L(row);
    }
    stats.anonRoot++; stats.lazyRows++;
    return out;
  }
  const ctor = getCtorFactory(cls.f, dictFlags, 0)(cls.d);
  for (let k = 0; k < raw.length; k++) {
    const row = raw[k];
    if (!Array.isArray(row) || row.length !== nf) { stats.anonReject++; return undefined; }
    out[k] = ctor(row);
  }
  stats.anonRoot++;
  return out;
}

// ANONYMOUS-DEEP — same marker-free transform, but for documents whose rows
// live somewhere inside the tree (the very common API envelope
// {meta:{...}, data:[...rows]}). After the transform a row is just an array,
// so we find "row runs" (arrays whose every element is an array of exactly
// nFields) and convert them. Soundness comes from a global count guard:
// every real instance is necessarily a candidate, so if the number of
// converted rows equals the number of `C0(` occurrences in the source, the
// candidate set is exactly the real set. Any mismatch -> caller falls back.
function tryAnonymousDeep(text, pre, name, lazy) {
  const body = text.slice(pre.end);
  const open = name + '(';
  const expect = countOcc(body, open);
  if (expect === 0) return undefined;
  const t = body.replaceAll(open, '[').replaceAll(')', ']');
  let raw;
  try { raw = JSON.parse(t); } catch (e) { return undefined; }
  const cls = pre.classes[name];
  const nf = cls.f.length;
  const dictFlags = cls.d.map(d => (d === null ? 0 : 1));
  const make = lazy
    ? (() => { const L = getLazyClass(cls.f, dictFlags, 0)(cls.d); return (r) => new L(r); })()
    : getCtorFactory(cls.f, dictFlags, 0)(cls.d);
  let converted = 0;

  function walk(v) {
    if (Array.isArray(v)) {
      const n = v.length;
      // is this a run of rows?
      let isRun = n > 0;
      for (let k = 0; k < n; k++) {
        const e = v[k];
        if (!Array.isArray(e) || e.length !== nf) { isRun = false; break; }
      }
      if (isRun) {
        const out = new Array(n);
        for (let k = 0; k < n; k++) { out[k] = make(v[k]); converted++; }
        return out;
      }
      for (let k = 0; k < n; k++) {
        const e = v[k];
        if (e !== null && typeof e === 'object') v[k] = walk(e);
      }
      return v;
    }
    for (const k in v) {
      const e = v[k];
      if (e !== null && typeof e === 'object') v[k] = walk(e);
    }
    return v;
  }

  if (raw === null || typeof raw !== 'object') return undefined;
  const out = walk(raw);
  if (converted !== expect) { stats.deepReject++; return undefined; } // ambiguous -> fall back
  stats.anonDeep++;
  return out;
}

function decode(text) {
  const pre = parsePrelude(text);
  // Table-mode documents are plain JSON and must never be text-transformed:
  // their rows are serialized by JSON.stringify, so the transform would corrupt
  // any string containing a bracket.
  if (pre.tables && pre.tables.length > 0) {
    try { return applyTables(JSON.parse(text.slice(pre.end)), pre); }
    catch (e) { return parseFast(text); }
  }
  const names = Object.keys(pre.classes);
  if (names.length === 0) {
    // plain JSON body — hand it straight to the native parser
    stats.plainJson++;
    return JSON.parse(pre.end === 0 ? text : text.slice(pre.end));
  }
  if (hasMarkerCollision(text)) { stats.fallbackScanner++; return parseFast(text); }
  if (names.length === 1) {
    const fastOut = tryAnonymous(text, pre, names[0], false);
    if (fastOut !== undefined) return fastOut;
    const deepOut = tryAnonymousDeep(text, pre, names[0], false);
    if (deepOut !== undefined) return deepOut;
  }
  const t = transform(text, pre);
  let raw;
  try { raw = JSON.parse(t); }
  catch (e) { stats.fallbackScanner++; return parseFast(text); } // non-canonical body
  const ctors = buildCtors(pre.classes, 1);

  // uniform-root fast path: all top-level elements are flat marker rows of the
  // same class -> tight ctor loop instead of the generic recursive walk.
  if (Array.isArray(raw) && raw.length > 0) {
    const h0 = raw[0];
    if (Array.isArray(h0) && typeof h0[0] === 'string' && h0[0].charCodeAt(0) === 1) {
      const marker = h0[0];
      const ctor = ctors[marker.slice(1)];
      let flat = true;
      for (let k = 0; k < raw.length; k++) {
        const row = raw[k];
        if (!Array.isArray(row) || row[0] !== marker) { flat = false; break; }
        for (let q = 1; q < row.length; q++) {
          const e = row[q];
          if (e !== null && typeof e === 'object') { flat = false; break; }
        }
        if (!flat) break;
      }
      if (flat) {
        const out = new Array(raw.length);
        for (let k = 0; k < raw.length; k++) out[k] = ctor(raw[k]);
        stats.markerTight++;
        return out;
      }
    }
  }

  // Tight loop for a homogeneous run of flat marker rows at ANY depth —
  // this is what makes the common API envelope {data:[...rows], meta:{}}
  // as fast as a bare root array. Returns null when not applicable.
  function tightRows(v) {
    const n = v.length;
    if (n === 0) return null;
    const h0 = v[0];
    if (!Array.isArray(h0)) return null;
    const marker = h0[0];
    if (typeof marker !== 'string' || marker.charCodeAt(0) !== 1) return null;
    for (let k = 0; k < n; k++) {
      const row = v[k];
      if (!Array.isArray(row) || row[0] !== marker) return null;
      for (let q = 1; q < row.length; q++) {
        const e = row[q];
        if (e !== null && typeof e === 'object') return null;
      }
    }
    const ctor = ctors[marker.slice(1)];
    const out = new Array(n);
    for (let k = 0; k < n; k++) out[k] = ctor(v[k]);
    return out;
  }

  // generic post-order fixup
  function fix(v) {
    if (Array.isArray(v)) {
      const n = v.length;
      if (n > 0) {
        const h = v[0];
        if (typeof h === 'string' && h.charCodeAt(0) === 1) {
          for (let k = 1; k < n; k++) {
            const e = v[k];
            if (e !== null && typeof e === 'object') v[k] = fix(e);
          }
          return ctors[h.slice(1)](v);
        }
        const tight = tightRows(v);
        if (tight !== null) return tight;
      }
      for (let k = 0; k < n; k++) {
        const e = v[k];
        if (e !== null && typeof e === 'object') v[k] = fix(e);
      }
      return v;
    }
    for (const k in v) {
      const e = v[k];
      if (e !== null && typeof e === 'object') v[k] = fix(e);
    }
    return v;
  }
  if (raw !== null && typeof raw === 'object') { stats.markerWalk++; return fix(raw); }
  return raw;
}

// LAZY variant: rows are thin wrappers with prototype getters. Parse cost is
// transform + JSON.parse + one wrapper alloc per row; field access pays a
// getter indirection later. NOTE: fields live on the prototype, so Object.keys
// on a row returns ['_r'] — use toJSON()/JSON.stringify for a plain object.
function decodeLazy(text) {
  const pre = parsePrelude(text);
  if (pre.tables && pre.tables.length > 0) return decode(text);
  const names = Object.keys(pre.classes);
  if (names.length === 0) return JSON.parse(pre.end === 0 ? text : text.slice(pre.end));
  if (hasMarkerCollision(text)) return parseFast(text);
  if (names.length === 1) {
    const fastOut = tryAnonymous(text, pre, names[0], true);
    if (fastOut !== undefined) return fastOut;
  }
  const t = transform(text, pre);
  let raw;
  try { raw = JSON.parse(t); } catch (e) { return parseFast(text); }
  if (Array.isArray(raw) && raw.length > 0) {
    const h0 = raw[0];
    if (Array.isArray(h0) && typeof h0[0] === 'string' && h0[0].charCodeAt(0) === 1) {
      const cname = h0[0].slice(1);
      const cls = pre.classes[cname];
      const dictFlags = cls.d.map(d => (d === null ? 0 : 1));
      const L = getLazyClass(cls.f, dictFlags, 1)(cls.d);
      const marker = h0[0];
      let uniform = true;
      const out = new Array(raw.length);
      for (let k = 0; k < raw.length; k++) {
        const row = raw[k];
        if (!Array.isArray(row) || row[0] !== marker) { uniform = false; break; }
        // Rows must be FLAT. A nested class instance inside a field is still a
        // raw marker array at this point, and the lazy wrapper does not walk
        // into fields — returning it would leak ["\u0001C1",...] to the caller.
        for (let q = 1; q < row.length; q++) {
          const e = row[q];
          if (e !== null && typeof e === 'object') { uniform = false; break; }
        }
        if (!uniform) break;
        out[k] = new L(row);
      }
      if (uniform) { stats.lazyRows++; return out; }
    }
  }
  return decode(text);
}

export { decode, decodeLazy, stats };
