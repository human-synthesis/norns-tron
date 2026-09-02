export const SPEC_EXT: '.t';
/** Accepted spec extensions, in preference order — `.t` is the default. */
export const SPEC_EXTS: readonly ['.t', '.tron'];
export const APP_SPEC: 'app';

/** On-disk filename for a module: its existing file, else `<name>.t`. */
export function specFilename(name: string, files?: Record<string, string>): string;

/** sha256 hex of a value's canonical text — the unit of change detection. */
export function specHash(value: unknown): string;

/** Decode one spec file (canonical or any TRON/JSON). */
export function readSpec(file: string): unknown;

/**
 * Write a value to `file` in canonical form, creating parent dirs.
 * No-op (changed: false) when on-disk bytes already match.
 */
export function writeSpec(
  file: string,
  value: unknown
): { text: string; hash: string; changed: boolean };

/** Read a whole `specs/` directory. */
export function readSpecs(dir: string): {
  app: unknown;
  modules: Record<string, unknown>;
  files: Record<string, string>;
  hashes: Record<string, string>;
  version: string;
};

/** Combine per-module hashes into one deterministic app version hash. */
export function combineHashes(hashes: Record<string, string>): string;
