// WASM decode path for all-numeric TRON class rows.
//
// The WASM scanner validates as it goes and returns a negative code for
// anything it will not represent exactly (strings, booleans, null, nesting,
// numbers wider than the exact Clinger range). So JS never has to *prove* a
// payload is numeric in advance — it tries, and any rejection falls back.
// That makes the fast path correct by construction rather than by heuristic.
//
// Dictionary-encoded columns are integers on the wire, so enum-encoded string
// and boolean columns pass straight through and are mapped back by index here.
//
// Exposes:
//   available()          -> bool
//   decode(text)         -> array of row objects, or undefined if not eligible
//   decodeColumnar(text) -> {fields, rows, cols, tape:Float64Array} or undefined
//                           (zero-copy-ish typed array; the 4x win)

import { parsePrelude } from './tron.js';
import { WASM_BASE64 } from './wasm-bytes.js';

// The binary is tiny (~1.7 KB), so it ships embedded as base64 — no `fs`, no
// asset plumbing, works identically in Node, Bun, and browser bundles.
// setWasmBinary() still overrides it (e.g. to test a newer scanner build).
let _wasmBytes = null;
function setWasmBinary(bytes) { _wasmBytes = bytes; initTried = false; ready = false; }

let mod = null, inst = null, exp = null, ready = false, initTried = false;
let inPtr = 0, inCap = 0, outPtr = 0, outCap = 0;
const encoder = new TextEncoder();

function init() {
  if (initTried) return ready;
  initTried = true;
  try {
    let buf = _wasmBytes;
    if (buf === null) buf = decodeBase64(WASM_BASE64);
    if (typeof WebAssembly === 'undefined') { ready = false; return false; }
    mod = new WebAssembly.Module(buf);
    inst = new WebAssembly.Instance(mod, { env: { abort() { throw new Error('wasm abort'); } } });
    exp = inst.exports;
    ready = true;
  } catch (e) {
    ready = false;
  }
  return ready;
}

function decodeBase64(b64) {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function available() { return init(); }

function ensureIn(bytes) {
  if (bytes > inCap) {
    const want = Math.max(bytes, inCap * 2, 1 << 16);
    inPtr = exp.allocate(want);
    inCap = want;
  }
  return inPtr;
}
function ensureOut(floats) {
  if (floats > outCap) {
    const want = Math.max(floats, outCap * 2, 1 << 14);
    outPtr = exp.allocate(want * 8);
    outCap = want;
  }
  return outPtr;
}

// True if the first row contains only characters that can appear in a numeric
// row. Conservative: any quote/letter/bracket makes this false.
function probeNumericRow(body) {
  const open = body.indexOf('(');
  if (open === -1) return false;
  const close = body.indexOf(')', open);
  if (close === -1) return false;
  for (let i = open + 1; i < close; i++) {
    const c = body.charCodeAt(i);
    if (c >= 48 && c <= 57) continue;          // 0-9
    if (c === 43 || c === 45 || c === 46) continue; // + - .
    if (c === 101 || c === 69) continue;       // e E
    if (c === 44 || c === 32) continue;        // , space
    return false;
  }
  return close > open + 1;
}

// Shared core: returns {cls, tape, count} or undefined.
function scan(text) {
  if (!init()) return undefined;
  const pre = parsePrelude(text);
  const names = Object.keys(pre.classes);
  if (names.length !== 1) return undefined;         // single-class documents only
  const cls = pre.classes[names[0]];
  const nf = cls.f.length;
  if (nf === 0) return undefined;

  const body = text.slice(pre.end);
  if (body.charCodeAt(0) !== 91 /* [ */) return undefined;
  // Cheap pre-check on the FIRST row only. The WASM validator is what
  // guarantees correctness; this exists purely to avoid paying for a UTF-8
  // encode of the whole body on payloads that obviously contain strings.
  if (!probeNumericRow(body)) return undefined;

  const bytes = encoder.encode(body);
  const ip = ensureIn(bytes.length);
  new Uint8Array(exp.memory.buffer, ip, bytes.length).set(bytes);

  // capacity guess: at most one float per 2 bytes of body
  const cap = Math.max(nf, Math.ceil(bytes.length / 2));
  const op = ensureOut(cap);

  const count = exp.parseTronTape(ip, bytes.length, op, outCap);
  if (count < 0) return undefined;                  // rejected -> caller falls back
  if (count % nf !== 0) return undefined;
  const tape = new Float64Array(exp.memory.buffer, op, count);
  return { cls, nf, tape, count, rows: count / nf };
}

function decode(text) {
  const r = scan(text);
  if (r === undefined) return undefined;
  const { cls, nf, tape, rows } = r;
  const fields = cls.f, dicts = cls.d;
  const out = new Array(rows);
  let hasDict = false;
  for (let k = 0; k < nf; k++) if (dicts[k] !== null) { hasDict = true; break; }
  let p = 0;
  if (!hasDict) {
    for (let i = 0; i < rows; i++) {
      const o = {};
      for (let k = 0; k < nf; k++) o[fields[k]] = tape[p++];
      out[i] = o;
    }
  } else {
    for (let i = 0; i < rows; i++) {
      const o = {};
      for (let k = 0; k < nf; k++) {
        const d = dicts[k];
        const v = tape[p++];
        o[fields[k]] = d === null ? v : d[v];
      }
      out[i] = o;
    }
  }
  return out;
}

// Columnar view — the mode where WASM is ~4x faster than JSON.parse, because
// nothing is materialized as JS objects at all. `tape` aliases WASM memory and
// is invalidated by the next decode call; pass copy=true to detach it.
function decodeColumnar(text, copy) {
  const r = scan(text);
  if (r === undefined) return undefined;
  return {
    fields: r.cls.f.slice(),
    dicts: r.cls.d,
    rows: r.rows,
    cols: r.nf,
    tape: copy ? new Float64Array(r.tape) : r.tape,
  };
}

export { available, decode, decodeColumnar, setWasmBinary };
