// TRON — Token Reduced Object Notation (interpretation of the documented format).
// A superset of JSON that adds class declarations + positional instantiation:
//
//   class User: id,name,role
//   [User(1,"Ada","admin"), User(2,"Bob","user")]
//
// Repeated object shapes are hoisted to a class, so keys are written once.
// Goal: parse via a single-pass char-code scanner (no regex in the hot path).

// ---------- Character codes ----------
const TAB = 9, LF = 10, CR = 13, SPACE = 32,
  QUOTE = 34, COMMA = 44, MINUS = 45, DOT = 46,
  COLON = 58, LBRACKET = 91, RBRACKET = 93,
  LBRACE = 123, RBRACE = 125, LPAREN = 40, RPAREN = 41,
  BACKSLASH = 92, ZERO = 48, NINE = 57, PLUS = 43,
  n_e = 101, n_E = 69;

// Exact powers of ten (10^0..10^22 are all exactly representable as f64).
const POW10 = new Float64Array(23);
for (let p = 0; p < 23; p++) POW10[p] = Math.pow(10, p);

function isWs(c) { return c === SPACE || c === TAB || c === LF || c === CR; }
function isDigit(c) { return c >= ZERO && c <= NINE; }
function isIdentStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isIdentPart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || isDigit(c) || c === DOT;
}

// ======================================================================
// PRELUDE — shared reader for `enum E: v1,v2` and `class C: f1,f2@E`
// declaration lines at the top of a document. Returns { classes, end }
// where classes maps name -> { f: fields[], d: (values[]|null)[] }.
// ======================================================================
function parsePrelude(s) {
  const len = s.length;
  let i = 0;
  const enums = Object.create(null);
  const classes = Object.create(null);
  const tables = [];
  function ws() { let c; while (i < len && ((c = s.charCodeAt(i)) === SPACE || c === TAB || c === LF || c === CR)) i++; }
  function sp() { let c; while (i < len && ((c = s.charCodeAt(i)) === SPACE || c === TAB)) i++; }
  function ident() { const st = i; while (i < len && isIdentPart(s.charCodeAt(i))) i++; return s.slice(st, i); }
  function quotedStr() { // JSON string semantics; i at opening quote
    i++; let out = '', seg = i;
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c === QUOTE) { out += s.slice(seg, i); i++; return out; }
      if (c === BACKSLASH) {
        out += s.slice(seg, i); i++;
        const e = s.charCodeAt(i);
        switch (e) {
          case QUOTE: out += '"'; break; case BACKSLASH: out += '\\'; break;
          case 47: out += '/'; break; case 110: out += '\n'; break;
          case 116: out += '\t'; break; case 114: out += '\r'; break;
          case 98: out += '\b'; break; case 102: out += '\f'; break;
          case 117: out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; break;
        }
        i++; seg = i;
      } else i++;
    }
    return out + s.slice(seg);
  }
  ws();
  for (;;) {
    if (s.startsWith('enum ', i)) {
      i += 5; sp();
      const name = ident(); sp();
      if (s.charCodeAt(i) !== COLON) break;
      i++;
      const values = [];
      for (;;) {
        sp();
        if (s.charCodeAt(i) === QUOTE) values.push(quotedStr());
        else {
          const st = i; let c;
          while (i < len && (c = s.charCodeAt(i)) !== COMMA && c !== LF && c !== CR) i++;
          let e2 = i;
          while (e2 > st && (s.charCodeAt(e2 - 1) === SPACE || s.charCodeAt(e2 - 1) === TAB)) e2--;
          const raw = s.slice(st, e2);
          // Bare tokens are typed: this is what lets a dictionary hold
          // booleans (and therefore lets boolean columns reach the WASM path).
          if (raw === 'true') values.push(true);
          else if (raw === 'false') values.push(false);
          else if (raw === 'null') values.push(null);
          else values.push(raw);
        }
        sp();
        if (s.charCodeAt(i) === COMMA) { i++; continue; }
        break;
      }
      enums[name] = values; ws();
    } else if (s.startsWith('table ', i)) {
      // `table C0: $.data` — declares that the value at <path> is an array of
      // C0 rows serialized as plain JSON arrays. Lets the decoder skip the
      // text transform entirely: JSON.parse the body, walk to the path, build.
      i += 6; sp();
      const cname = ident(); sp();
      if (s.charCodeAt(i) !== COLON) break;
      i++; sp();
      const st = i;
      while (i < len && s.charCodeAt(i) !== LF && s.charCodeAt(i) !== CR) i++;
      let e2 = i;
      while (e2 > st && (s.charCodeAt(e2 - 1) === SPACE || s.charCodeAt(e2 - 1) === TAB)) e2--;
      tables.push({ cls: cname, path: s.slice(st, e2) });
      ws();
    } else if (s.startsWith('class ', i)) {
      i += 6; sp();
      const name = ident(); sp();
      if (s.charCodeAt(i) !== COLON) break;
      i++;
      const fields = [], dicts = [];
      for (;;) {
        sp();
        // Field names are quoted when they are not plain identifiers (spaces,
        // colons, parens, commas, non-ASCII...). Without this, such keys
        // corrupt the declaration line.
        fields.push(s.charCodeAt(i) === QUOTE ? quotedStr() : ident());
        if (s.charCodeAt(i) === 64 /* @ */) { i++; const ref = ident(); dicts.push(enums[ref] || null); }
        else dicts.push(null);
        sp();
        if (s.charCodeAt(i) === COMMA) { i++; continue; }
        break;
      }
      classes[name] = { f: fields, d: dicts };
      ws();
    } else break;
  }
  return { classes, tables, end: i };
}


// ======================================================================
// applyTables — convert `table Ck: <path>` regions from plain JSON arrays
// into row objects. Shared by every decoder so a table-mode document decodes
// identically no matter which entry point is used.
// ======================================================================
const _tblCtorCache = new Map();
function _tblCtor(fields, dictFlags, dicts) {
  const key = dictFlags.join('') + '|' + fields.join(',');
  let fac = _tblCtorCache.get(key);
  if (!fac) {
    let body = 'return function(r){return {';
    for (let k = 0; k < fields.length; k++) {
      if (k) body += ',';
      body += JSON.stringify(fields[k]) + ':' + (dictFlags[k] === 1 ? ('D[' + k + '][r[' + k + ']]') : ('r[' + k + ']'));
    }
    body += '}}';
    fac = new Function('D', body);
    _tblCtorCache.set(key, fac);
  }
  return fac(dicts);
}

function parseTablePath(p) {
  if (p.charCodeAt(0) !== 36) return null;
  const segs = []; let i = 1; const n = p.length;
  while (i < n) {
    const c = p.charCodeAt(i);
    if (c === 46) {
      i++; const st = i;
      while (i < n) { const d = p.charCodeAt(i); if (d === 46 || d === 91) break; i++; }
      segs.push(p.slice(st, i));
    } else if (c === 91) {
      i++;
      if (p.charCodeAt(i) === 34) {
        let out = '', seg = ++i;
        for (;;) {
          if (i >= n) return null;
          const d = p.charCodeAt(i);
          if (d === 34) { out += p.slice(seg, i); i++; break; }
          if (d === 92) { out += p.slice(seg, i); i++; out += p[i]; i++; seg = i; }
          else i++;
        }
        segs.push(out);
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

function applyTables(root, pre) {
  const tables = pre.tables;
  if (!tables || tables.length === 0) return root;
  for (let t = 0; t < tables.length; t++) {
    const decl = tables[t];
    const cls = pre.classes[decl.cls];
    if (!cls) continue;
    const segs = parseTablePath(decl.path);
    if (segs === null) continue;
    let parent = null, lastSeg = null, cur = root;
    let ok = true;
    for (let q = 0; q < segs.length; q++) {
      if (cur === null || typeof cur !== 'object') { ok = false; break; }
      parent = cur; lastSeg = segs[q]; cur = cur[segs[q]];
    }
    if (!ok || !Array.isArray(cur)) continue;
    const fields = cls.f, dicts = cls.d, nf = fields.length;
    const dictFlags = new Array(nf);
    let hasDict = false;
    for (let k = 0; k < nf; k++) { dictFlags[k] = dicts[k] === null ? 0 : 1; if (dictFlags[k]) hasDict = true; }
    const ctor = _tblCtor(fields, dictFlags, hasDict ? dicts : null);
    const n = cur.length;
    const out = new Array(n);
    let good = true;
    for (let i = 0; i < n; i++) {
      const row = cur[i];
      if (!Array.isArray(row) || row.length !== nf) { good = false; break; }
      out[i] = ctor(row);
    }
    if (!good) continue;
    if (parent === null) root = out; else parent[lastSeg] = out;
  }
  return root;
}

// ======================================================================
// PARSE
// ======================================================================
function parse(input) {
  const s = input;
  const len = s.length;
  let i = 0;
  const classes = Object.create(null); // name -> [fields]

  function ws() {
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c === SPACE || c === TAB || c === LF || c === CR) i++;
      else break;
    }
  }

  function err(msg) {
    throw new SyntaxError(`TRON: ${msg} at index ${i}`);
  }

  function readIdent() {
    const start = i;
    if (!isIdentStart(s.charCodeAt(i))) err('expected identifier');
    i++;
    while (i < len && isIdentPart(s.charCodeAt(i))) i++;
    return s.slice(start, i);
  }

  function readString() {
    // assumes current char is opening quote
    i++; // skip "
    let start = i;
    let result = '';
    let hasEscape = false;
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c === QUOTE) {
        if (!hasEscape) { const out = s.slice(start, i); i++; return out; }
        result += s.slice(start, i); i++; return result;
      }
      if (c === BACKSLASH) {
        hasEscape = true;
        result += s.slice(start, i);
        i++;
        const e = s.charCodeAt(i);
        switch (e) {
          case QUOTE: result += '"'; break;
          case BACKSLASH: result += '\\'; break;
          case 47: result += '/'; break;
          case 110: result += '\n'; break;
          case 116: result += '\t'; break;
          case 114: result += '\r'; break;
          case 98: result += '\b'; break;
          case 102: result += '\f'; break;
          case 117: {
            const hex = s.slice(i + 1, i + 5);
            result += String.fromCharCode(parseInt(hex, 16));
            i += 4; break;
          }
          default: err('bad escape');
        }
        i++;
        start = i;
      } else {
        i++;
      }
    }
    err('unterminated string');
  }

  // Allocation-free number reader with an exact (Clinger) fast path:
  // if the significand has <=15 digits and the decimal exponent is in
  // [-22,22], significand * 10^e (or / 10^-e) is correctly rounded, so we
  // avoid building a substring + Number() on the hot path. Falls back to
  // Number(slice) for the rare wide/large-exponent value.
  function readNumber() {
    const start = i;
    let c = s.charCodeAt(i);
    let neg = false;
    if (c === MINUS) { neg = true; i++; } else if (c === PLUS) { i++; }
    let mant = 0, digits = 0, overflow = false;
    while (i < len) { c = s.charCodeAt(i); if (c < ZERO || c > NINE) break; if (digits < 15) { mant = mant * 10 + (c - ZERO); digits++; } else overflow = true; i++; }
    let fracDigits = 0;
    if (i < len && s.charCodeAt(i) === DOT) {
      i++;
      while (i < len) { c = s.charCodeAt(i); if (c < ZERO || c > NINE) break; if (digits < 15) { mant = mant * 10 + (c - ZERO); digits++; fracDigits++; } else overflow = true; i++; }
    }
    let hasExp = false, expNeg = false, exp = 0;
    if (i < len) { c = s.charCodeAt(i); if (c === n_e || c === n_E) { hasExp = true; i++; c = s.charCodeAt(i); if (c === PLUS) i++; else if (c === MINUS) { expNeg = true; i++; } while (i < len) { c = s.charCodeAt(i); if (c < ZERO || c > NINE) break; exp = exp * 10 + (c - ZERO); i++; } } }
    const e = (hasExp ? (expNeg ? -exp : exp) : 0) - fracDigits;
    if (!overflow && e >= -22 && e <= 22) {
      const val = e >= 0 ? mant * POW10[e] : mant / POW10[-e];
      return neg ? -val : val;
    }
    return +s.slice(start, i);
  }

  function readArray() {
    i++; // [
    const arr = [];
    ws();
    if (s.charCodeAt(i) === RBRACKET) { i++; return arr; }
    for (;;) {
      arr.push(readValue());
      ws();
      const c = s.charCodeAt(i);
      if (c === COMMA) { i++; ws(); continue; }
      if (c === RBRACKET) { i++; return arr; }
      err('expected , or ] in array');
    }
  }

  function readObject() {
    i++; // {
    const obj = {};
    ws();
    if (s.charCodeAt(i) === RBRACE) { i++; return obj; }
    for (;;) {
      ws();
      let key;
      const c = s.charCodeAt(i);
      if (c === QUOTE) key = readString();
      else key = readIdent(); // TRON allows unquoted keys
      ws();
      if (s.charCodeAt(i) !== COLON) err('expected : after key');
      i++;
      ws();
      obj[key] = readValue();
      ws();
      const d = s.charCodeAt(i);
      if (d === COMMA) { i++; continue; }
      if (d === RBRACE) { i++; return obj; }
      err('expected , or } in object');
    }
  }

  function readInstantiation(name) {
    // current char is '(' ; name already read
    const cls = classes[name];
    if (!cls) err(`unknown class "${name}"`);
    const fields = cls.f, dicts = cls.d;
    i++; // (
    const obj = {};
    ws();
    if (s.charCodeAt(i) === RPAREN) { i++; return obj; }
    let fi = 0;
    for (;;) {
      const v = readValue();
      const dd = dicts[fi];
      obj[fields[fi++]] = dd === null ? v : dd[v];
      ws();
      const c = s.charCodeAt(i);
      if (c === COMMA) { i++; ws(); continue; }
      if (c === RPAREN) { i++; return obj; }
      err('expected , or ) in instantiation');
    }
  }

  function readValue() {
    ws();
    const c = s.charCodeAt(i);
    switch (c) {
      case QUOTE: return readString();
      case LBRACKET: return readArray();
      case LBRACE: return readObject();
      case MINUS: return readNumber();
      default:
        if (isDigit(c)) return readNumber();
        if (isIdentStart(c)) {
          const id = readIdent();
          // keyword / class instantiation / bare word
          if (id === 'true') return true;
          if (id === 'false') return false;
          if (id === 'null') return null;
          ws();
          if (s.charCodeAt(i) === LPAREN) return readInstantiation(id);
          return id; // bare identifier -> string (lenient)
        }
        err('unexpected character');
    }
  }

  // ---- declarations at the top (shared prelude reader) ----
  const pre = parsePrelude(s);
  for (const cname in pre.classes) classes[cname] = pre.classes[cname];
  i = pre.end;
  let value = readValue();
  value = applyTables(value, pre);
  ws();
  if (i < len) err('trailing content');
  return value;
}

// ======================================================================
// STRINGIFY
// ======================================================================
// Strategy: find repeated object "shapes" (ordered key signatures). Any shape
// used >= MIN_USES times becomes a class, so its keys are emitted once.
const MIN_USES = 2;
const DICT_MAX_UNIQUES = 64;

// A field name may be written bare in a class declaration only if it is a
// plain ASCII identifier; otherwise it must be quoted.
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
  // bare unless ambiguous on a comma-separated decl line
  if (v.length === 0 || v === 'true' || v === 'false' || v === 'null') return JSON.stringify(v);
  const f = v.charCodeAt(0), l = v.charCodeAt(v.length - 1);
  if (f === 32 || l === 32 || f === 9 || l === 9 || f === QUOTE) return JSON.stringify(v);
  for (let k = 0; k < v.length; k++) {
    const c = v.charCodeAt(k);
    if (c === COMMA || c === QUOTE || c === BACKSLASH || c < 32) return JSON.stringify(v);
  }
  // numeric-looking values must be quoted so decode keeps them as strings
  if (!Number.isNaN(Number(v))) return JSON.stringify(v);
  return v;
}

function stringify(value, opts) {
  const useDict = !!(opts && opts.dict);
  // Pass 1: count shapes (+ per-field string stats when dict is on).
  const shapeCounts = new Map(); // signature -> {count, keys, stats}
  (function scan(v) {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (let k = 0; k < v.length; k++) scan(v[k]); return; }
    const keys = Object.keys(v);
    // only "flat-ish" shapes are worth classing; still class nested, values scanned anyway
    const sig = keys.join('\u0000');
    let e = shapeCounts.get(sig);
    if (!e) {
      e = { count: 0, keys, stats: null };
      if (useDict) {
        e.stats = new Array(keys.length);
        for (let k = 0; k < keys.length; k++) e.stats[k] = { m: new Map(), ok: true, total: 0, bytes: 0 };
      }
      shapeCounts.set(sig, e);
    }
    e.count++;
    if (useDict) {
      for (let k = 0; k < keys.length; k++) {
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

  // Assign class names to repeated shapes (skip empty objects).
  const sigToClass = new Map();
  const classDecls = [];
  const enumDecls = [];
  const enumBySig = new Map(); // JSON.stringify(values) -> enum name
  let cn = 0, en = 0;
  for (const [sig, e] of shapeCounts) {
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
      sigToClass.set(sig, { name, keys: e.keys, dictMaps });
      classDecls.push('class ' + name + ': ' + declFields.join(','));
    }
  }

  const out = [];
  function encStr(str) {
    // JSON-compatible string quoting. Parens are additionally escaped as
    // (/) so that in canonical TRON every raw "(" / ")" in the
    // document is structural — this is what makes the JSON.parse trampoline
    // (see tron-trampoline.js) a safe pure-text transform.
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
  function enc(v) {
    if (v === null) { out.push('null'); return; }
    const t = typeof v;
    if (t === 'string') { out.push(encStr(v)); return; }
    if (t === 'number') { out.push(Number.isFinite(v) ? String(v) : 'null'); return; }
    if (t === 'boolean') { out.push(v ? 'true' : 'false'); return; }
    if (t === 'undefined') { out.push('null'); return; }
    if (Array.isArray(v)) {
      out.push('[');
      for (let k = 0; k < v.length; k++) { if (k) out.push(','); enc(v[k]); }
      out.push(']');
      return;
    }
    // object
    const keys = Object.keys(v);
    const sig = keys.join('\u0000');
    const cls = sigToClass.get(sig);
    if (cls) {
      out.push(cls.name, '(');
      const dm = cls.dictMaps;
      for (let k = 0; k < cls.keys.length; k++) {
        if (k) out.push(',');
        const dmk = dm === null ? null : dm[k];
        if (dmk) out.push('' + dmk.get(v[cls.keys[k]]));
        else enc(v[cls.keys[k]]);
      }
      out.push(')');
    } else {
      out.push('{');
      for (let k = 0; k < keys.length; k++) {
        if (k) out.push(',');
        out.push(encStr(keys[k]), ':');
        enc(v[keys[k]]);
      }
      out.push('}');
    }
  }
  enc(value);
  const body = out.join('');
  if (classDecls.length === 0 && enumDecls.length === 0) return body;
  const decls = enumDecls.concat(classDecls);
  return decls.join('\n') + '\n' + body;
}

// ======================================================================
// parseFast — canonical fast path.
// Assumes the compact form our stringify() emits (no insignificant
// whitespace outside strings). Inlines every reader, skips per-token
// whitespace scanning, and reads class instances positionally. Tolerates
// incidental spaces/newlines cheaply at structural separators so ordinary
// JSON (a TRON subset) with spacing still parses.
// ======================================================================
function parseFast(input) {
  const s = input;
  const len = s.length;
  let i = 0;
  const classes = Object.create(null);

  function err(m) { throw new SyntaxError(`TRON: ${m} at ${i}`); }

  // cheap inline whitespace skip (one comparison in the common no-ws case)
  function sw() {
    let c;
    while (i < len && ((c = s.charCodeAt(i)) === SPACE || c === LF || c === TAB || c === CR)) i++;
  }

  function readStr() {
    i++; // "
    let start = i, out = '', esc = false;
    for (;;) {
      const c = s.charCodeAt(i);
      if (c === QUOTE) { if (!esc) { const r = s.slice(start, i); i++; return r; } out += s.slice(start, i); i++; return out; }
      if (c === BACKSLASH) {
        esc = true; out += s.slice(start, i); i++;
        const e = s.charCodeAt(i);
        switch (e) {
          case QUOTE: out += '"'; break; case BACKSLASH: out += '\\'; break;
          case 47: out += '/'; break; case 110: out += '\n'; break;
          case 116: out += '\t'; break; case 114: out += '\r'; break;
          case 98: out += '\b'; break; case 102: out += '\f'; break;
          case 117: out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; break;
          default: err('bad escape');
        }
        i++; start = i;
      } else if (c !== c) { err('unterminated string'); } else i++;
      if (i > len) err('unterminated string');
    }
  }

  function readNum() {
    const start = i;
    let c = s.charCodeAt(i), neg = false;
    if (c === MINUS) { neg = true; i++; } else if (c === PLUS) i++;
    let mant = 0, digits = 0, overflow = false;
    while (i < len) { c = s.charCodeAt(i); if (c < ZERO || c > NINE) break; if (digits < 15) { mant = mant * 10 + (c - ZERO); digits++; } else overflow = true; i++; }
    let frac = 0;
    if (i < len && s.charCodeAt(i) === DOT) { i++; while (i < len) { c = s.charCodeAt(i); if (c < ZERO || c > NINE) break; if (digits < 15) { mant = mant * 10 + (c - ZERO); digits++; frac++; } else overflow = true; i++; } }
    let he = false, en = false, ex = 0;
    if (i < len) { c = s.charCodeAt(i); if (c === n_e || c === n_E) { he = true; i++; c = s.charCodeAt(i); if (c === PLUS) i++; else if (c === MINUS) { en = true; i++; } while (i < len) { c = s.charCodeAt(i); if (c < ZERO || c > NINE) break; ex = ex * 10 + (c - ZERO); i++; } } }
    const e = (he ? (en ? -ex : ex) : 0) - frac;
    if (!overflow && e >= -22 && e <= 22) { const v = e >= 0 ? mant * POW10[e] : mant / POW10[-e]; return neg ? -v : v; }
    return +s.slice(start, i);
  }

  function readIdent() {
    const start = i; i++;
    while (i < len && isIdentPart(s.charCodeAt(i))) i++;
    return s.slice(start, i);
  }

  function readVal() {
    const c = s.charCodeAt(i);
    if (c === QUOTE) return readStr();
    if (c >= ZERO && c <= NINE) return readNum();
    if (c === MINUS) return readNum();
    if (c === LBRACE) {
      i++; sw(); // {
      if (s.charCodeAt(i) === RBRACE) { i++; return {}; }
      const o = {};
      for (;;) {
        const k = s.charCodeAt(i) === QUOTE ? readStr() : readIdent();
        if (s.charCodeAt(i) !== COLON) { sw(); if (s.charCodeAt(i) !== COLON) err('expected :'); }
        i++; sw();
        o[k] = readVal();
        let d = s.charCodeAt(i);
        if (d !== COMMA && d !== RBRACE) { sw(); d = s.charCodeAt(i); }
        if (d === COMMA) { i++; sw(); continue; }
        if (d === RBRACE) { i++; return o; }
        err('expected , or }');
      }
    }
    if (c === LBRACKET) {
      i++; sw(); // [
      if (s.charCodeAt(i) === RBRACKET) { i++; return []; }
      const a = [];
      for (;;) {
        a.push(readVal());
        let d = s.charCodeAt(i);
        if (d !== COMMA && d !== RBRACKET) { sw(); d = s.charCodeAt(i); }
        if (d === COMMA) { i++; sw(); continue; }
        if (d === RBRACKET) { i++; return a; }
        err('expected , or ]');
      }
    }
    if (isIdentStart(c)) {
      const id = readIdent();
      if (id === 'true') return true;
      if (id === 'false') return false;
      if (id === 'null') return null;
      // class instantiation?
      let pc = s.charCodeAt(i);
      if (pc !== LPAREN) { const save = i; sw(); if (s.charCodeAt(i) === LPAREN) pc = LPAREN; else { i = save; return id; } }
      const cls = classes[id];
      if (!cls) err(`unknown class ${id}`);
      const flds = cls.f, dcts = cls.d;
      i++; sw(); // (
      const o = {};
      if (s.charCodeAt(i) === RPAREN) { i++; return o; }
      let fi = 0;
      for (;;) {
        const vv = readVal();
        const dd = dcts[fi];
        o[flds[fi++]] = dd === null ? vv : dd[vv];
        let d = s.charCodeAt(i);
        if (d !== COMMA && d !== RPAREN) { sw(); d = s.charCodeAt(i); }
        if (d === COMMA) { i++; sw(); continue; }
        if (d === RPAREN) { i++; return o; }
        err('expected , or )');
      }
    }
    err('unexpected char');
  }

  // declarations (shared prelude reader)
  const pre = parsePrelude(s);
  for (const cname in pre.classes) classes[cname] = pre.classes[cname];
  i = pre.end;
  sw();
  const v = readVal();
  return applyTables(v, pre);
}

export { parse, parseFast, stringify, parsePrelude, applyTables, parse as parseTolerant };
