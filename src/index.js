/**
 * norns-tron — TRON encoder/decoder for LLM-oriented APIs.
 * Core absorbed from the apitron research library (same authors).
 *
 * Two modes:
 *
 *   1. SELF-DESCRIBING — encode(value) / decode(wire)
 *      The payload carries its own declarations, so any consumer can read it
 *      cold (an LLM, a third party). Use for prompts and public responses.
 *
 *   2. SCHEMA-PRELOADED — defineSchema(spec) -> { encode, decode }
 *      Both ends share an interface contract, so nothing describing the shape
 *      travels on the wire and the row constructor is compiled once at startup.
 *      Fastest on every axis. Use for internal APIs.
 *
 * Zero runtime dependencies. WASM is optional and loaded lazily.
 */

import * as TRON from './core/tron.js';
import * as ENCODER from './core/tron-encode.js';
import * as AUTO from './core/tron-auto.js';
import * as SCHEMA from './core/tron-schema.js';
import * as WASM from './core/tron-wasm.js';

// Below this many bytes of equivalent JSON, the fixed costs of shape detection
// dominate and plain JSON is simply faster and no smaller. Measured crossover
// is ~1 KB for size and ~5 KB for decode; 1 KB is the conservative default.
const DEFAULT_MIN_BYTES = 1024;

/**
 * Encode a value as self-describing TRON.
 *
 * Falls back to plain JSON for payloads under `minBytes` — decode() reads that
 * transparently, since a document with no declarations is just JSON.
 *
 * @param {*} value
 * @param {{minBytes?:number, dict?:boolean, table?:boolean|'nested', force?:boolean}} [opts]
 * @returns {string}
 */
function encode(value, opts) {
  const o = opts || {};
  const minBytes = o.minBytes === undefined ? DEFAULT_MIN_BYTES : o.minBytes;
  if (!o.force && minBytes > 0) {
    const json = JSON.stringify(value);
    if (json === undefined) return 'null';
    if (json.length < minBytes) return json;       // too small to be worth it
  }
  return ENCODER.stringify(value, {
    dict: o.dict === undefined ? true : o.dict,
    table: o.table === undefined ? true : o.table,
  });
}

/**
 * Decode any TRON document — including plain JSON, which is valid TRON.
 * Picks the fastest safe strategy automatically.
 * @param {string} text
 * @returns {*}
 */
function decode(text) {
  return AUTO.decode(text);
}

/**
 * Encode specifically for `decodeColumnar`.
 *
 * The default `encode()` emits `table` declarations, which makes the body plain
 * JSON — great for the object path, but the WASM scanner looks for the `Ck(...)`
 * row syntax and will not accept it. This helper emits the form the columnar
 * decoder can actually take (dictionaries on, table declarations off).
 *
 * Use it only when the consumer calls `decodeColumnar`; for everything else
 * `encode()` is the better default.
 *
 * @param {*} value
 * @param {{minBytes?:number, force?:boolean}} [opts]
 * @returns {string}
 */
function encodeColumnar(value, opts) {
  const o = opts || {};
  return encode(value, {
    minBytes: o.minBytes,
    force: o.force === undefined ? true : o.force,
    dict: true,
    table: false,
  });
}

/**
 * Decode an all-numeric (or fully dictionary-encoded) table into a flat
 * Float64Array instead of JS objects.
 *
 * This is the fastest decode path — ~3x faster than JSON.parse — but the caller
 * must be able to work columnar.
 *
 * NOTE: the payload must come from `encodeColumnar()`. Output of the default
 * `encode()` is NOT eligible (it emits table declarations, which the WASM
 * scanner does not accept) and this returns undefined for it.
 *
 * @param {string} text
 * @param {boolean} [copy] copy the tape out of WASM memory (it is otherwise
 *        invalidated by the next decode call)
 * @returns {{fields:string[], rows:number, cols:number, tape:Float64Array}|undefined}
 */
function decodeColumnar(text, copy) {
  return AUTO.decodeColumnar(text, copy);
}

/**
 * PRELOAD — compile a schema once, at startup, from your interface contract.
 *
 *   const users = defineSchema({
 *     id:     'users.v1',                       // optional #tag for routing
 *     fields: ['id', 'name', 'role', 'score'],  // exact order matters
 *     enums:  { role: ['admin', 'user'] },      // strings/booleans only
 *     path:   '$.data',                         // '$' = root array
 *   });
 *
 * @param {{id?:string, fields:string[], enums?:Object, path?:string}} spec
 * @returns {{encode:Function, decode:Function, peek:Function, fields:string[], id:?string}}
 */
function defineSchema(spec) {
  return SCHEMA.compile(spec);
}

/**
 * A registry for services serving several response shapes. PEEK routes a
 * document to its schema by its `#id` tag without parsing the body.
 */
function createRegistry() {
  return SCHEMA.createRegistry();
}

/** True when the WASM fast path is usable in this environment. */
function wasmAvailable() {
  try { return AUTO.wasmAvailable(); } catch (e) { return false; }
}

/**
 * Supply the WASM binary yourself (browsers, bundlers, Deno).
 * @param {ArrayBuffer|Uint8Array} bytes contents of wasm/parserTron2.wasm
 */
function setWasmBinary(bytes) {
  WASM.setWasmBinary(bytes);
}

// Lower-level entry points, for when you want to bypass the dispatcher.
const raw = {
  stringify: ENCODER.stringify,   // always encodes, no size threshold
  parse: TRON.parse,              // tolerant scanner (accepts whitespace, unquoted keys)
  parseFast: TRON.parseFast,      // strict scanner, no `new Function` needed
  parsePrelude: TRON.parsePrelude,
};

export {
  encode,
  decode,
  encodeColumnar,
  decodeColumnar,
  defineSchema,
  createRegistry,
  wasmAvailable,
  setWasmBinary,
  raw,
};
