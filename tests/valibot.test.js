import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { tronSpecFromValibot, tronSchemaFromValibot } from '../src/valibot.js';

const note = v.object({
	id: v.number(),
	title: v.string(),
	status: v.picklist(['draft', 'published', 'archived']),
	pinned: v.boolean(),
	author: v.optional(v.picklist(['me', 'you'])),
	body: v.nullable(v.string())
});

describe('tronSpecFromValibot', () => {
	test('derives fields in declaration order', () => {
		const spec = tronSpecFromValibot(note);
		expect(spec.fields).toEqual(['id', 'title', 'status', 'pinned', 'author', 'body']);
	});

	test('derives enums from picklist, boolean, and wrapped picklist', () => {
		const spec = tronSpecFromValibot(note);
		expect(spec.enums.status).toEqual(['draft', 'published', 'archived']);
		expect(spec.enums.pinned).toEqual([false, true]);
		expect(spec.enums.author).toEqual(['me', 'you']);
		expect(spec.enums.title).toBeUndefined();
		expect(spec.enums.body).toBeUndefined();
	});

	test('numeric picklists are skipped (ambiguous with dictionary indices)', () => {
		const spec = tronSpecFromValibot(v.object({ level: v.picklist([1, 2, 3]) }));
		expect(spec.enums).toBeUndefined();
	});

	test('passes id and path through', () => {
		const spec = tronSpecFromValibot(note, { id: 'notes.v1', path: '$.data' });
		expect(spec.id).toBe('notes.v1');
		expect(spec.path).toBe('$.data');
	});

	test('rejects non-object schemas', () => {
		expect(() => tronSpecFromValibot(v.string())).toThrow('expected a valibot object schema');
	});
});

describe('tronSchemaFromValibot', () => {
	test('compiled schema roundtrips rows', () => {
		const wire = tronSchemaFromValibot(note, { id: 'notes.v1', path: '$.data' });
		const value = {
			data: [
				{ id: 1, title: 'a', status: 'draft', pinned: true, author: 'me', body: null },
				{ id: 2, title: 'b', status: 'published', pinned: false, author: 'you', body: 'text' }
			]
		};
		const encoded = wire.encode(value);
		expect(encoded.startsWith('#notes.v1\n')).toBe(true);
		expect(wire.decode(encoded)).toEqual(value);
	});
});
