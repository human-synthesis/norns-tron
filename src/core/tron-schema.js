// SCHEMA PRE-REGISTRATION — "preload, peek, process".
//
// In a real API the client already knows the response shape from the interface
// contract (OpenAPI / TypeScript type / proto). Everything the self-describing
// format spends per request to *discover* that shape is therefore waste:
//
//   encode side   shape-detection pass, dictionary statistics pass, building
//                 the class/enum/table declarations, emitting the prelude
//   wire          the prelude bytes/tokens, on every single response
//   decode side   parsing the prelude, parsing the table path, compiling the
//                 row constructor
//
// With the schema registered once at startup, all of that collapses to:
//
//   PRELOAD  compile(spec)  -> field order, enum tables, row constructor,
//                              resolved path — built once, reused forever
//   PEEK     (optional) read a short version tag to pick the right schema
//   PROCESS  JSON.parse + a tight constructor loop
//
// This matters most exactly where the self-describing format was weakest: small
// responses, where the fixed costs have nothing to amortize against, and where
// the prelude can be a large fraction of the payload.
//
// Wire format is plain JSON — no prelude at all:
//     {"meta":{...},"data":[[1,"Ada",0],[2,"Bob",1]]}
// Optionally prefixed with a version tag for the PEEK step:
//     #users.v1
//     {"meta":{...},"data":[[...]]}

// ---------------------------------------------------------------- helpers
function parsePathSegs(p) {
  if (!p || p === '$') return [];
  if (p.charCodeAt(0) !== 36) throw new Error('schema path must start with $');
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
      if (p.charCodeAt(i) === 34) {
        let out = '', seg = ++i;
        for (;;) {
          if (i >= n) throw new Error('bad path');
          const d = p.charCodeAt(i);
          if (d === 34) { out += p.slice(seg, i); i++; break; }
          if (d === 92) { out += p.slice(seg, i); i++; out += p[i]; i++; seg = i; }
          else i++;
        }
        segs.push(out);
        if (p.charCodeAt(i) !== 93) throw new Error('bad path');
        i++;
      } else {
        const st = i;
        while (i < n && p.charCodeAt(i) !== 93) i++;
        segs.push(Number(p.slice(st, i)));
        i++;
      }
    } else throw new Error('bad path');
  }
  return segs;
}

// ---------------------------------------------------------------- compile
// spec = {
//   id:      optional string, emitted/matched as a "#id" peek tag
//   fields:  ordered field names (from the interface)
//   enums:   optional { fieldName: [values...] } dictionaries
//   path:    where the table sits, default '$' (root array)
// }
function compile(spec) {
  const fields = spec.fields.slice();
  const nf = fields.length;
  const segs = parsePathSegs(spec.path || '$');
  const id = spec.id || null;
  const tag = id ? '#' + id + '\n' : '';

  // per-field dictionaries, resolved once
  const decTables = new Array(nf).fill(null);   // index -> value
  const encTables = new Array(nf).fill(null);   // value -> index
  if (spec.enums) {
    for (let k = 0; k < nf; k++) {
      const vals = spec.enums[fields[k]];
      if (!vals) continue;
      // SOUNDNESS: a dictionary column carries an integer index on the wire, and
      // a value outside the declared set is passed through literally. The
      // decoder tells them apart by `typeof === "number"`, so NUMERIC enum
      // values are ambiguous with indices — an out-of-set number would decode
      // as undefined. Only string/boolean dictionaries are representable.
      for (let q = 0; q < vals.length; q++) {
        const t = typeof vals[q];
        if (t !== 'string' && t !== 'boolean') {
          throw new Error('enum values for "' + fields[k] + '" must be strings or booleans (got ' + t + '); numeric values are ambiguous with dictionary indices');
        }
      }
      decTables[k] = vals.slice();
      const m = new Map();
      for (let q = 0; q < vals.length; q++) m.set(vals[q], q);
      encTables[k] = m;
    }
  }
  const anyDict = decTables.some(d => d !== null);

  // ---- row constructor, compiled ONCE at startup rather than per request ----
  // A dictionary column may still carry a literal string if the encoder saw a
  // value outside the declared set, so those columns test the wire type.
  let body = 'return function(r){return {';
  for (let k = 0; k < nf; k++) {
    if (k) body += ',';
    const src = decTables[k] === null
      ? 'r[' + k + ']'
      : '(typeof r[' + k + ']==="number"?D[' + k + '][r[' + k + ']]:r[' + k + '])';
    body += JSON.stringify(fields[k]) + ':' + src;
  }
  body += '}}';
  const ctor = new Function('D', body)(decTables);

  // navigate to the table's container; compiled to a straight-line walk
  function locate(root) {
    let parent = null, last = null, cur = root;
    for (let q = 0; q < segs.length; q++) {
      if (cur === null || typeof cur !== 'object') return null;
      parent = cur; last = segs[q]; cur = cur[segs[q]];
    }
    return { parent, last, cur };
  }

  // ---------------------------------------------------------- PROCESS
  function decode(text) {
    // PEEK: skip an optional "#id" tag line without scanning the payload
    let body2 = text;
    if (text.charCodeAt(0) === 35 /* # */) {
      const nl = text.indexOf('\n');
      if (nl === -1) throw new Error('schema tag without body');
      body2 = text.slice(nl + 1);
    }
    const root = JSON.parse(body2);
    const loc = locate(root);
    if (loc === null || !Array.isArray(loc.cur)) {
      throw new Error('schema path did not resolve to an array');
    }
    const rows = loc.cur;
    const n = rows.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = ctor(rows[i]);
    if (loc.parent === null) return out;
    loc.parent[loc.last] = out;
    return root;
  }

  // Returns the id of a document without parsing it (cheap routing).
  function peek(text) {
    if (text.charCodeAt(0) !== 35) return null;
    const nl = text.indexOf('\n');
    return nl === -1 ? null : text.slice(1, nl);
  }

  // ---------------------------------------------------------- encode
  // No shape detection and no dictionary statistics: the schema already says
  // the field order and the enum tables.
  function projectRows(rows) {
    const n = rows.length;
    const proj = new Array(n);
    if (!anyDict) {
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        const a = new Array(nf);
        for (let k = 0; k < nf; k++) a[k] = r[fields[k]];
        proj[i] = a;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        const a = new Array(nf);
        for (let k = 0; k < nf; k++) {
          const m = encTables[k];
          if (m === null) { a[k] = r[fields[k]]; continue; }
          const v = r[fields[k]];
          const idx = m.get(v);
          a[k] = idx === undefined ? v : idx;   // unknown value passes through
        }
        proj[i] = a;
      }
    }
    return proj;
  }

  function encode(value) {
    if (segs.length === 0) return tag + JSON.stringify(projectRows(value));
    // replace the table in a shallow copy so the caller's object is untouched
    const cloneAlong = (node, depth) => {
      if (depth === segs.length) return projectRows(node);
      const key = segs[depth];
      const copy = Array.isArray(node) ? node.slice() : Object.assign({}, node);
      copy[key] = cloneAlong(node[key], depth + 1);
      return copy;
    };
    return tag + JSON.stringify(cloneAlong(value, 0));
  }

  return { encode, decode, peek, fields, id };
}

// A registry, for services that serve several response shapes.
function createRegistry() {
  const byId = new Map();
  return {
    register(spec) { const s = compile(spec); if (s.id) byId.set(s.id, s); return s; },
    get(id) { return byId.get(id); },
    // PEEK then PROCESS: route a document to its schema by tag alone.
    decode(text) {
      if (text.charCodeAt(0) !== 35) throw new Error('document has no schema tag');
      const nl = text.indexOf('\n');
      const id = text.slice(1, nl);
      const s = byId.get(id);
      if (!s) throw new Error('unknown schema id: ' + id);
      return s.decode(text);
    },
  };
}

export { compile, createRegistry };
