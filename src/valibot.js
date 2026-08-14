/**
 * Derive a TRON schema spec from a valibot object schema, so the wire contract
 * lives in one place — the feature's `shared/schema.c`.
 *
 *   // shared/schema.c
 *   export noteSchema := v.object({ id: v.number(), title: v.string(),
 *                                   status: v.picklist(['draft','published']) })
 *   export noteWire := tronSchemaFromValibot(noteSchema, { id: 'notes.v1', path: '$.data' })
 *
 *   // server:  route({ serializer: tronSerializer({ schema: noteWire }), handler })
 *   // client:  noteWire.decode(await res.text())
 *
 * Derivation rules:
 *   - fields    = object entry names, in declaration order
 *   - picklist  -> enum (string options only; numeric picklists are skipped —
 *                 numbers are ambiguous with dictionary indices on the wire)
 *   - enum      -> enum from its string values
 *   - boolean   -> enum [false, true] (a boolean column as 0/1 on the wire)
 *   - optional / nullable / nullish wrappers are unwrapped first
 */
import { defineSchema } from './index.js';

function unwrap(schema) {
	let s = schema;
	while (s && (s.type === 'optional' || s.type === 'nullable' || s.type === 'nullish' || s.type === 'non_optional' || s.type === 'non_nullable' || s.type === 'non_nullish')) {
		s = s.wrapped;
	}
	return s;
}

function enumValues(schema) {
	const s = unwrap(schema);
	if (!s) return null;
	if (s.type === 'picklist' && Array.isArray(s.options)) {
		return s.options.every((o) => typeof o === 'string') ? s.options.slice() : null;
	}
	if (s.type === 'enum' && s.enum && typeof s.enum === 'object') {
		const vals = Object.values(s.enum).filter((v) => typeof v === 'string');
		return vals.length > 0 ? vals : null;
	}
	if (s.type === 'boolean') return [false, true];
	if (s.type === 'literal' && (typeof s.literal === 'string' || typeof s.literal === 'boolean')) {
		return [s.literal];
	}
	return null;
}

/**
 * Derive the plain spec — useful when you want to tweak it before compiling.
 *
 * @param {any} objectSchema a valibot v.object(...) schema
 * @param {{id?: string, path?: string}} [opts]
 * @returns {{id?: string, fields: string[], enums?: Record<string, any[]>, path?: string}}
 */
export function tronSpecFromValibot(objectSchema, opts = {}) {
	const s = unwrap(objectSchema);
	if (!s || s.type !== 'object' || !s.entries) {
		throw new Error('tronSpecFromValibot: expected a valibot object schema (got ' + (s?.type ?? typeof objectSchema) + ')');
	}
	const fields = Object.keys(s.entries);
	/** @type {Record<string, any[]>} */
	const enums = {};
	let any = false;
	for (const f of fields) {
		const vals = enumValues(s.entries[f]);
		if (vals) { enums[f] = vals; any = true; }
	}
	const spec = { fields };
	if (any) spec.enums = enums;
	if (opts.id) spec.id = opts.id;
	if (opts.path) spec.path = opts.path;
	return spec;
}

/**
 * Derive and compile in one step (defineSchema is a startup-time cost — call
 * this at module scope, never per request).
 *
 * @param {any} objectSchema a valibot v.object(...) schema
 * @param {{id?: string, path?: string}} [opts]
 */
export function tronSchemaFromValibot(objectSchema, opts = {}) {
	return defineSchema(tronSpecFromValibot(objectSchema, opts));
}
