import { describe, expect, test } from 'bun:test';

import { decode, formatCanonical, SPEC_KEY_PRIORITY } from '../src/index.js';

const sampleSpec = {
  entities: {
    Order: {
      uid: '01J8QF0000000000000000000',
      owner: 'customer',
      fields: {
        customer: { type: 'ref', ref: 'core.Entity.User' },
        total: { type: 'money' },
        note: { type: 'text', optional: true },
      },
      status: { draft: ['submitted'], submitted: ['paid', 'cancelled'] },
    },
  },
  module: 'orders',
  depends: ['core', 'catalog'],
  actions: {
    submit: {
      input: { id: 'Order.id' },
      requires: 'status == draft',
      steps: [{ set: { entity: 'Order', status: 'submitted' } }, { emit: 'order.submitted' }],
      refresh: ['orders.Query.board'],
      examples: [{ input: { id: '$draft' }, expect: { status: 'submitted' } }],
    },
  },
  policies: { Order: { read: 'owner or role:admin', write: 'owner' } },
};

describe('determinism', () => {
  test('same value → byte-identical text', () => {
    expect(formatCanonical(sampleSpec)).toBe(formatCanonical(sampleSpec));
  });

  test('key insertion order is irrelevant', () => {
    const a = formatCanonical({ b: 1, a: 2, module: 'x' });
    const b = formatCanonical({ module: 'x', a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test('deep clones format identically', () => {
    const clone = JSON.parse(JSON.stringify(sampleSpec));
    expect(formatCanonical(clone)).toBe(formatCanonical(sampleSpec));
  });
});

describe('round-trip', () => {
  test('decode(format(v)) deep-equals v', () => {
    expect(decode(formatCanonical(sampleSpec))).toEqual(sampleSpec);
  });

  test('JSON.parse reads canonical text (JSON compatibility)', () => {
    expect(JSON.parse(formatCanonical(sampleSpec))).toEqual(sampleSpec);
  });

  test('format(decode(format(v))) is a fixed point', () => {
    const once = formatCanonical(sampleSpec);
    expect(formatCanonical(decode(once))).toBe(once);
  });

  test('scalars and empties', () => {
    for (const v of [null, true, false, 0, -1.5, 'hé"llo\n', [], {}, [[]], [{}]]) {
      expect(decode(formatCanonical(v))).toEqual(JSON.parse(JSON.stringify(v)));
    }
  });
});

describe('JSON value semantics', () => {
  test('Date → ISO string via toJSON', () => {
    const d = new Date('2026-09-01T12:00:00.000Z');
    expect(decode(formatCanonical({ at: d }))).toEqual({ at: '2026-09-01T12:00:00.000Z' });
  });

  test('undefined keys dropped; undefined in arrays → null', () => {
    expect(decode(formatCanonical({ a: undefined, b: 1 }))).toEqual({ b: 1 });
    expect(decode(formatCanonical([undefined, 1]))).toEqual([null, 1]);
  });

  test('top-level undefined → null document', () => {
    expect(formatCanonical(undefined)).toBe('null\n');
  });

  test('NaN and Infinity → null', () => {
    expect(decode(formatCanonical({ a: NaN, b: Infinity }))).toEqual({ a: null, b: null });
  });
});

describe('layout', () => {
  test('LF endings, single trailing newline, no trailing spaces', () => {
    const text = formatCanonical(sampleSpec);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text.includes('\r')).toBe(false);
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd());
  });

  test('short leaves inline, long nodes break one field per line', () => {
    const text = formatCanonical(sampleSpec);
    expect(text).toContain('"total": { "type": "money" }'); // inline leaf
    expect(text).toContain('"entities": {\n'); // block collection
  });

  test('priority keys lead: module/depends before collections', () => {
    const lines = formatCanonical(sampleSpec).split('\n');
    const idx = (k) => lines.findIndex((l) => l.startsWith(`  "${k}"`));
    expect(idx('module')).toBeLessThan(idx('depends'));
    expect(idx('depends')).toBeLessThan(idx('entities'));
    expect(idx('entities')).toBeLessThan(idx('actions'));
    expect(idx('actions')).toBeLessThan(idx('policies'));
  });

  test('unknown keys sort alphabetically after priority keys', () => {
    const text = formatCanonical({ zeta: 1, alpha: 2, module: 'm' }, { maxInline: 0 });
    const lines = text.split('\n');
    expect(lines[1]).toContain('"module"');
    expect(lines[2]).toContain('"alpha"');
    expect(lines[3]).toContain('"zeta"');
  });

  test('maxInline: 0 forces full block form', () => {
    const text = formatCanonical({ a: [1, 2] }, { maxInline: 0 });
    expect(text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  });

  test('custom keyPriority overrides the spec default', () => {
    const text = formatCanonical({ module: 'm', zzz: 1 }, { keyPriority: ['zzz'], maxInline: 0 });
    const lines = text.split('\n');
    expect(lines[1]).toContain('"zzz"');
    expect(lines[2]).toContain('"module"');
  });
});

describe('exports', () => {
  test('SPEC_KEY_PRIORITY is a non-empty string list starting with module', () => {
    expect(Array.isArray(SPEC_KEY_PRIORITY)).toBe(true);
    expect(SPEC_KEY_PRIORITY[0]).toBe('module');
  });
});

describe('fuzz: random values are deterministic and round-trip', () => {
  // Deterministic PRNG so failures reproduce.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const randomValue = (depth) => {
    const r = rnd();
    if (depth > 3 || r < 0.3) {
      const leaves = [null, true, false, 0, 1, -2.5, 1e21, 'str', '"\\\n\t', 'ünïcode✓', ''];
      return leaves[Math.floor(rnd() * leaves.length)];
    }
    if (r < 0.65) {
      return Array.from({ length: Math.floor(rnd() * 6) }, () => randomValue(depth + 1));
    }
    const obj = {};
    const n = Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) obj['k' + Math.floor(rnd() * 20)] = randomValue(depth + 1);
    return obj;
  };

  test('200 random documents', () => {
    for (let i = 0; i < 200; i++) {
      const v = randomValue(0);
      const text = formatCanonical(v);
      expect(formatCanonical(v)).toBe(text);
      expect(decode(text)).toEqual(JSON.parse(JSON.stringify(v)));
      expect(formatCanonical(decode(text))).toBe(text);
    }
  });
});
