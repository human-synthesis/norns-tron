// Auto-dispatching decoder. No single strategy wins on every shape, so pick
// per document from cheap signals available in the prelude + a short probe:
//
//   numeric columnar, all classed        -> WASM tape (4x JSON.parse)
//   single/multi-class uniform tables    -> trampoline (0.7-0.9x)
//   nested / irregular / tiny            -> parseFast scanner (~1.2x)
//
// The probe reads only the class declarations and a small prefix of the body,
// never the whole payload, so dispatch cost is O(prelude), not O(document).

import * as TRON from './tron.js';
import * as TRAMP from './tron-trampoline.js';
import * as WASM from './tron-wasm.js';
import * as TBL from './tron-table.js';

const SMALL_DOC = 4096;         // below this, native JSON.parse setup dominates
const PROBE_ROWS = 3;

function pickStrategy(text) {
  const pre = TRON.parsePrelude(text);
  const names = Object.keys(pre.classes);
  if (names.length === 0) return 'json';     // plain JSON body
  if (text.length < SMALL_DOC) return 'fast';
  if (text.indexOf('\u0001') !== -1) return 'fast';

  // Several classes means heterogeneous, nesting-heavy data: the trampoline's
  // generic walk loses badly there (measured 1.8x) while the scanner stays
  // ~1.1x. One class means a dominant uniform run - the trampoline's home turf.
  if (names.length > 1) return 'fast';

  // Body must look like a root array of instances for the tight paths.
  const body = text.slice(pre.end);
  if (body.charCodeAt(0) !== 91 /* [ */) return 'tramp-generic';

  // Probe the first few rows for non-scalar fields (nested objects/arrays).
  let i = 1, rows = 0, sawNonScalar = false;
  while (rows < PROBE_ROWS && i < body.length) {
    const open = body.indexOf('(', i);
    if (open === -1) break;
    const close = body.indexOf(')', open);
    if (close === -1) break;
    const row = body.slice(open + 1, close);
    if (row.indexOf('[') !== -1 || row.indexOf('{') !== -1) sawNonScalar = true;
    i = close + 1; rows++;
  }
  if (sawNonScalar) return 'tramp-generic';
  return 'tramp';
}

function decode(text, opts) {
  // TABLE MODE first: if the document declares where its tables live, decoding
  // is JSON.parse + a constructor loop with no text transform at all.
  const pre = TRON.parsePrelude(text);
  if (pre.tables && pre.tables.length > 0) {
    const t = TBL.decode(text, pre);
    if (t !== undefined) return t;
  }
  const strategy = (opts && opts.strategy) || pickStrategy(text);
  switch (strategy) {
    case 'json': return JSON.parse(text.slice(TRON.parsePrelude(text).end) || text);
    case 'fast': return TRON.parseFast(text);
    case 'tramp': {
      // Try WASM first for uniform single-class rows. The WASM scanner
      // validates and rejects anything it cannot represent exactly, so an
      // undefined return is a definitive "not eligible", not a guess.
      if (!(opts && opts.noWasm) && !(opts && opts.lazy)) {
        const w = WASM.decode(text);
        if (w !== undefined) return w;
      }
      return (opts && opts.lazy) ? TRAMP.decodeLazy(text) : TRAMP.decode(text);
    }
    case 'tramp-generic': return TRAMP.decode(text);
    default: return TRON.parseFast(text);
  }
}

// Columnar decode: returns a Float64Array view instead of JS objects for
// all-numeric (or fully dictionary-encoded) tables. Undefined when the payload
// is not eligible. This is the mode that runs ~4x faster than JSON.parse.
function decodeColumnar(text, copy) {
  return WASM.decodeColumnar(text, copy);
}

const wasmAvailable = () => WASM.available();
export { decode, decodeColumnar, pickStrategy, wasmAvailable };
