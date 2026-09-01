/**
 * Canonical pretty-printer for on-disk TRON spec files.
 *
 * The canonical form is the git-tracked representation of a Norns spec:
 * deterministic (same value -> byte-identical text), line-oriented (one field
 * per line so diffs and merges stay readable), and JSON-compatible (plain JSON
 * is valid TRON, so `decode()` reads canonical files with zero special cases).
 *
 * Rules:
 *   - JSON value semantics: `toJSON()` honored (Dates -> ISO strings),
 *     `undefined` keys dropped, NaN/Infinity -> null — exactly JSON.stringify.
 *   - Keys sorted: priority list first (spec-aware default), rest by codepoint.
 *   - A node renders inline when its one-line form fits `maxInline` columns at
 *     its indentation; otherwise one child per line. The rule is a pure
 *     function of the value, so formatting never depends on prior state.
 *   - 2-space indent, LF, single trailing newline.
 */

/**
 * Spec-aware key ordering: identity and contract keys surface before bulk
 * collections, so unit diffs lead with what a reviewer needs first. Unknown
 * keys sort after all of these, alphabetically.
 */
export const SPEC_KEY_PRIORITY = [
  // app / module identity
  'module', 'depends', 'dialect', 'uid', 'name',
  // unit contract essentials
  'type', 'ref', 'from', 'route', 'owner', 'input', 'requires', 'transport',
  'props', 'events', 'slots', 'live', 'groupBy',
  // unit body
  'fields', 'status', 'steps', 'emits', 'refresh', 'read', 'write',
  'state', 'components', 'examples', 'impl', 'source', 'body',
  // module collections (bulk, last)
  'entities', 'queries', 'actions', 'policies', 'pages',
  'triggers', 'functions', 'settings',
];

const DEFAULT_MAX_INLINE = 100;
const DEFAULT_INDENT = 2;

/**
 * Format a value as canonical TRON text.
 *
 * @param {*} value anything JSON.stringify accepts
 * @param {{indent?:number, maxInline?:number, keyPriority?:string[]}} [opts]
 * @returns {string} canonical text, LF line endings, single trailing newline
 */
export function formatCanonical(value, opts) {
  const o = opts || {};
  const ctx = {
    indent: ' '.repeat(o.indent === undefined ? DEFAULT_INDENT : o.indent),
    maxInline: o.maxInline === undefined ? DEFAULT_MAX_INLINE : o.maxInline,
    priority: buildPriority(o.keyPriority === undefined ? SPEC_KEY_PRIORITY : o.keyPriority),
  };
  // Normalize through JSON to inherit its value semantics exactly
  // (toJSON, undefined-key dropping, NaN -> null, BigInt throws).
  const json = JSON.stringify(value);
  if (json === undefined) return 'null\n';
  const tree = JSON.parse(json);
  return render(tree, '', ctx) + '\n';
}

function buildPriority(list) {
  const m = new Map();
  for (let i = 0; i < list.length; i++) if (!m.has(list[i])) m.set(list[i], i);
  return m;
}

function sortedKeys(node, priority) {
  return Object.keys(node).sort((a, b) => {
    const pa = priority.has(a) ? priority.get(a) : Infinity;
    const pb = priority.has(b) ? priority.get(b) : Infinity;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function inline(node, ctx) {
  if (node === null || typeof node !== 'object') return JSON.stringify(node);
  if (Array.isArray(node)) {
    if (node.length === 0) return '[]';
    const parts = new Array(node.length);
    for (let i = 0; i < node.length; i++) parts[i] = inline(node[i], ctx);
    return '[' + parts.join(', ') + ']';
  }
  const keys = sortedKeys(node, ctx.priority);
  if (keys.length === 0) return '{}';
  const parts = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    parts[i] = JSON.stringify(keys[i]) + ': ' + inline(node[keys[i]], ctx);
  }
  return '{ ' + parts.join(', ') + ' }';
}

function render(node, pad, ctx) {
  const flat = inline(node, ctx);
  if (pad.length + flat.length <= ctx.maxInline) return flat;
  if (node === null || typeof node !== 'object') return flat;
  const childPad = pad + ctx.indent;
  if (Array.isArray(node)) {
    const items = new Array(node.length);
    for (let i = 0; i < node.length; i++) {
      items[i] = childPad + render(node[i], childPad, ctx);
    }
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  const keys = sortedKeys(node, ctx.priority);
  const items = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    items[i] = childPad + JSON.stringify(keys[i]) + ': ' + render(node[keys[i]], childPad, ctx);
  }
  return '{\n' + items.join(',\n') + '\n' + pad + '}';
}
