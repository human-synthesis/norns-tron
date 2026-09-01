/**
 * Spec-file helpers — server-side only (`@human-synthesis/norns-tron/spec`).
 *
 * A Norns app's canonical spec lives in `specs/` as one `.tron` file per
 * module plus `app.tron`, written in canonical form (see canonical.js).
 * These helpers read/write that directory and compute the content-addressed
 * version hashes used by `ifVersion` optimistic checks and incremental
 * generation.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { formatCanonical } from './canonical.js';
import * as AUTO from './core/tron-auto.js';

export const SPEC_EXT = '.tron';
export const APP_SPEC = 'app';

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
 *   app: *,                            // app.tron contents (null if absent)
 *   modules: Record<string, *>,        // module name -> spec value
 *   hashes: Record<string, string>,    // per-file canonical hash (incl. 'app')
 *   version: string                    // hash over all files — the app version
 * }}
 */
export function readSpecs(dir) {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(SPEC_EXT))
    .sort();
  const modules = {};
  const hashes = {};
  let app = null;
  for (const f of names) {
    const name = basename(f, SPEC_EXT);
    const value = readSpec(join(dir, f));
    hashes[name] = specHash(value);
    if (name === APP_SPEC) app = value;
    else modules[name] = value;
  }
  return { app, modules, hashes, version: combineHashes(hashes) };
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
