/**
 * Spec-file helpers — server-side only (`@human-synthesis/norns-tron/spec`).
 *
 * A Norns app's canonical spec lives in `specs/` as one `.t` file per
 * module plus `app.t`, written in canonical form (see canonical.js). The
 * long-form `.tron` extension is accepted too; `.t` is the default for new
 * files, matching the other Norns extensions (`.n`, `.c`, `.p`).
 * These helpers read/write that directory and compute the content-addressed
 * version hashes used by `ifVersion` optimistic checks and incremental
 * generation.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { formatCanonical } from './canonical.js';
import * as AUTO from './core/tron-auto.js';

export const SPEC_EXT = '.t';
/** Accepted spec extensions, in preference order — `.t` is the default. */
export const SPEC_EXTS = ['.t', '.tron'];
export const APP_SPEC = 'app';

/** On-disk filename for a module: its existing file, else `<name>.t`. */
export function specFilename(name, files) {
  return files?.[name] ?? name + SPEC_EXT;
}

/** sha256 hex of a value's canonical text — the unit of change detection. */
export function specHash(value) {
  return createHash('sha256').update(formatCanonical(value), 'utf-8').digest('hex');
}

/** Decode one spec file (canonical or any TRON/JSON). */
export function readSpec(file) {
  return AUTO.decode(readFileSync(file, 'utf-8'));
}

/**
 * Write a value to `file` in canonical form, creating parent dirs.
 * Skips the write when the on-disk bytes already match, so watchers and
 * mtimes stay quiet on no-op applies.
 *
 * @returns {{ text: string, hash: string, changed: boolean }}
 */
export function writeSpec(file, value) {
  const text = formatCanonical(value);
  const hash = createHash('sha256').update(text, 'utf-8').digest('hex');
  let existing = null;
  try {
    existing = readFileSync(file, 'utf-8');
  } catch {
    // new file
  }
  if (existing === text) return { text, hash, changed: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf-8');
  return { text, hash, changed: true };
}

/**
 * Read a whole `specs/` directory.
 *
 * @param {string} dir
 * @returns {{
 *   app: *,                            // app spec contents (null if absent)
 *   modules: Record<string, *>,        // module name -> spec value
 *   files: Record<string, string>,     // module name -> on-disk filename
 *   hashes: Record<string, string>,    // per-file canonical hash (incl. 'app')
 *   version: string                    // hash over all files — the app version
 * }}
 */
export function readSpecs(dir) {
  const names = readdirSync(dir)
    .filter((f) => SPEC_EXTS.some((ext) => f.endsWith(ext)))
    .sort();
  const modules = {};
  const files = {};
  const hashes = {};
  let app = null;
  for (const f of names) {
    const ext = SPEC_EXTS.find((e) => f.endsWith(e));
    const name = basename(f, ext);
    if (files[name] !== undefined) {
      throw new Error(
        `duplicate spec for "${name}": ${files[name]} and ${f} — keep one (\`.t\` is the default)`
      );
    }
    files[name] = f;
    const value = readSpec(join(dir, f));
    hashes[name] = specHash(value);
    if (name === APP_SPEC) app = value;
    else modules[name] = value;
  }
  return { app, modules, files, hashes, version: combineHashes(hashes) };
}

/**
 * Combine per-module hashes into one app version hash. Order-independent
 * input, deterministic output.
 */
export function combineHashes(hashes) {
  const h = createHash('sha256');
  for (const name of Object.keys(hashes).sort()) {
    h.update(name).update(':').update(hashes[name]).update('\n');
  }
  return h.digest('hex');
}
