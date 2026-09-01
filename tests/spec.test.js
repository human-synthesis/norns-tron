import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatCanonical } from '../src/canonical.js';
import {
  APP_SPEC,
  SPEC_EXT,
  combineHashes,
  readSpec,
  readSpecs,
  specHash,
  writeSpec,
} from '../src/spec.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'norns-spec-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const APP = { name: 'demo', module: 'app', settings: { adapter: 'cloudflare' } };
const BLOG = {
  module: 'blog',
  entities: { Post: { fields: { title: 'text', body: 'text' } } },
};

describe('specHash', () => {
  test('is the sha256 of canonical text, stable across key order', () => {
    const a = specHash({ name: 'x', module: 'm' });
    const b = specHash({ module: 'm', name: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('differs for different values', () => {
    expect(specHash({ a: 1 })).not.toBe(specHash({ a: 2 }));
  });
});

describe('writeSpec / readSpec', () => {
  test('round-trips a value through disk in canonical form', () => {
    const { dir, done } = tmp();
    try {
      const file = join(dir, 'specs', `blog${SPEC_EXT}`);
      const { text, hash, changed } = writeSpec(file, BLOG);
      expect(changed).toBe(true);
      expect(text).toBe(formatCanonical(BLOG));
      expect(hash).toBe(specHash(BLOG));
      expect(readFileSync(file, 'utf-8')).toBe(text);
      expect(readSpec(file)).toEqual(BLOG);
    } finally {
      done();
    }
  });

  test('creates missing parent directories', () => {
    const { dir, done } = tmp();
    try {
      const file = join(dir, 'a', 'b', 'c', `app${SPEC_EXT}`);
      expect(writeSpec(file, APP).changed).toBe(true);
      expect(readSpec(file)).toEqual(APP);
    } finally {
      done();
    }
  });

  test('identical rewrite reports changed:false and leaves mtime alone', () => {
    const { dir, done } = tmp();
    try {
      const file = join(dir, `app${SPEC_EXT}`);
      writeSpec(file, APP);
      const before = statSync(file).mtimeMs;
      writeFileSync(file, readFileSync(file)); // ensure baseline mtime is settled
      const settled = statSync(file).mtimeMs;
      const again = writeSpec(file, { ...APP });
      expect(again.changed).toBe(false);
      expect(statSync(file).mtimeMs).toBe(settled);
      expect(again.hash).toBe(specHash(APP));
      expect(before).toBeLessThanOrEqual(settled);
    } finally {
      done();
    }
  });

  test('rewriting with a different value reports changed:true', () => {
    const { dir, done } = tmp();
    try {
      const file = join(dir, `app${SPEC_EXT}`);
      writeSpec(file, APP);
      const res = writeSpec(file, { ...APP, name: 'demo2' });
      expect(res.changed).toBe(true);
      expect(readSpec(file)).toEqual({ ...APP, name: 'demo2' });
    } finally {
      done();
    }
  });

  test('readSpec accepts non-canonical TRON/JSON input', () => {
    const { dir, done } = tmp();
    try {
      const file = join(dir, `raw${SPEC_EXT}`);
      writeFileSync(file, '{"module":"raw","name":"hand written"}', 'utf-8');
      expect(readSpec(file)).toEqual({ module: 'raw', name: 'hand written' });
    } finally {
      done();
    }
  });
});

describe('readSpecs', () => {
  test('splits app spec from modules and hashes every file', () => {
    const { dir, done } = tmp();
    try {
      writeSpec(join(dir, `${APP_SPEC}${SPEC_EXT}`), APP);
      writeSpec(join(dir, `blog${SPEC_EXT}`), BLOG);
      writeFileSync(join(dir, 'notes.md'), 'ignored', 'utf-8');

      const specs = readSpecs(dir);
      expect(specs.app).toEqual(APP);
      expect(Object.keys(specs.modules)).toEqual(['blog']);
      expect(specs.modules.blog).toEqual(BLOG);
      expect(Object.keys(specs.hashes).sort()).toEqual(['app', 'blog']);
      expect(specs.hashes.app).toBe(specHash(APP));
      expect(specs.hashes.blog).toBe(specHash(BLOG));
      expect(specs.version).toBe(combineHashes(specs.hashes));
    } finally {
      done();
    }
  });

  test('app is null when app.tron is absent', () => {
    const { dir, done } = tmp();
    try {
      writeSpec(join(dir, `blog${SPEC_EXT}`), BLOG);
      const specs = readSpecs(dir);
      expect(specs.app).toBeNull();
      expect(specs.modules.blog).toEqual(BLOG);
    } finally {
      done();
    }
  });

  test('version changes when one module changes, stays put otherwise', () => {
    const { dir, done } = tmp();
    try {
      writeSpec(join(dir, `${APP_SPEC}${SPEC_EXT}`), APP);
      writeSpec(join(dir, `blog${SPEC_EXT}`), BLOG);
      const v1 = readSpecs(dir).version;
      const v1again = readSpecs(dir).version;
      expect(v1again).toBe(v1);

      writeSpec(join(dir, `blog${SPEC_EXT}`), {
        ...BLOG,
        entities: { ...BLOG.entities, Comment: { fields: { body: 'text' } } },
      });
      const v2 = readSpecs(dir).version;
      expect(v2).not.toBe(v1);
    } finally {
      done();
    }
  });

  test('version changes when a module is added or removed', () => {
    const { dir, done } = tmp();
    try {
      writeSpec(join(dir, `blog${SPEC_EXT}`), BLOG);
      const v1 = readSpecs(dir).version;
      writeSpec(join(dir, `shop${SPEC_EXT}`), { module: 'shop' });
      const v2 = readSpecs(dir).version;
      expect(v2).not.toBe(v1);
      rmSync(join(dir, `shop${SPEC_EXT}`));
      expect(readSpecs(dir).version).toBe(v1);
    } finally {
      done();
    }
  });
});

describe('combineHashes', () => {
  test('is order-independent over insertion order', () => {
    const a = combineHashes({ app: 'h1', blog: 'h2' });
    const b = combineHashes({ blog: 'h2', app: 'h1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('name/hash pairing is not ambiguous', () => {
    expect(combineHashes({ a: 'bc', ab: 'c' })).not.toBe(combineHashes({ a: 'b', ab: 'cc' }));
    expect(combineHashes({ a: 'x' })).not.toBe(combineHashes({ b: 'x' }));
  });

  test('empty input is deterministic', () => {
    expect(combineHashes({})).toBe(combineHashes({}));
  });
});
