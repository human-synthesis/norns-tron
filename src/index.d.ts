/**
 * APITRON — TRON encoder/decoder for LLM-oriented APIs.
 */

export interface EncodeOptions {
  /**
   * Below this many bytes of equivalent JSON, encode() returns plain JSON
   * instead — under ~1 KB the fixed costs dominate and TRON is both slower and
   * no smaller. decode() reads plain JSON transparently. Default: 1024.
   * Set to 0 to always encode as TRON.
   */
  minBytes?: number;
  /** Dictionary-encode low-cardinality string/boolean columns. Default: true. */
  dict?: boolean;
  /**
   * Emit `table` declarations so decoding needs no text transform.
   * `true`  — flat uniform rows only (faster AND fewer tokens: always a win).
   * `'nested'` — also table-ify rows containing nested objects/arrays: faster
   *   still, but the inner shapes lose their own compression, so tokens can get
   *   worse. Opt in deliberately.
   * Default: true.
   */
  table?: boolean | 'nested';
  /** Skip the minBytes check entirely. */
  force?: boolean;
}

export interface SchemaSpec {
  /** Optional version tag, emitted as a `#id` line and used by the registry. */
  id?: string;
  /** Field names, in the exact order rows are serialized. */
  fields: string[];
  /**
   * Per-field dictionaries. Values must be strings or booleans — numeric enum
   * values are rejected because they are ambiguous with dictionary indices.
   */
  enums?: Record<string, Array<string | boolean>>;
  /** Where the row array lives: `'$'` (root) or e.g. `'$.data'`. Default `'$'`. */
  path?: string;
}

export interface CompiledSchema {
  encode(value: unknown): string;
  decode(text: string): unknown;
  /** Read the `#id` tag without parsing the body. Returns null when untagged. */
  peek(text: string): string | null;
  readonly fields: string[];
  readonly id: string | null;
}

export interface SchemaRegistry {
  register(spec: SchemaSpec): CompiledSchema;
  get(id: string): CompiledSchema | undefined;
  /** PEEK the `#id` tag, then decode with the matching schema. */
  decode(text: string): unknown;
}

export interface ColumnarResult {
  fields: string[];
  rows: number;
  cols: number;
  /** Row-major, length = rows * cols. */
  tape: Float64Array;
}

/** Encode as self-describing TRON (or plain JSON when under `minBytes`). */
export function encode(value: unknown, opts?: EncodeOptions): string;

/** Decode any TRON document, including plain JSON. */
export function decode(text: string): unknown;

/**
 * Encode specifically for `decodeColumnar`. The default `encode()` emits table
 * declarations, which the WASM scanner cannot take; this emits the form it can.
 */
export function encodeColumnar(value: unknown, opts?: { minBytes?: number; force?: boolean }): string;

/**
 * Decode a numeric/dictionary table to a flat Float64Array, or undefined.
 * The payload must come from `encodeColumnar()`.
 */
export function decodeColumnar(text: string, copy?: boolean): ColumnarResult | undefined;

/** PRELOAD: compile a schema once at startup from your interface contract. */
export function defineSchema(spec: SchemaSpec): CompiledSchema;

/** A registry for services serving several response shapes. */
export function createRegistry(): SchemaRegistry;

/** True when the WASM fast path is usable here. */
export function wasmAvailable(): boolean;

/** Supply the WASM binary yourself (browsers, bundlers, Deno). */
export function setWasmBinary(bytes: ArrayBuffer | Uint8Array): void;

export const raw: {
  stringify(value: unknown, opts?: EncodeOptions): string;
  parse(text: string): unknown;
  parseFast(text: string): unknown;
  parsePrelude(text: string): {
    classes: Record<string, { f: string[]; d: Array<Array<string | boolean> | null> }>;
    tables: Array<{ cls: string; path: string }>;
    end: number;
  };
};
