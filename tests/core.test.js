import { describe, expect, test } from 'bun:test';
import {
	encode,
	decode,
	encodeColumnar,
	decodeColumnar,
	defineSchema,
	createRegistry,
	wasmAvailable
} from '../src/index.js';

const rows = (n) =>
	Array.from({ length: n }, (_, i) => ({
		id: i,
		name: 'user' + i,
		role: i % 3 ? 'user' : 'admin',
		score: i * 1.5,
		active: i % 2 === 0
	}));

describe('self-describing mode', () => {
	test('roundtrips a typical API envelope', () => {
		const value = { meta: { n: 200 }, data: rows(200) };
		expect(decode(encode(value))).toEqual(value);
	});

	test('small payloads stay plain JSON (1 KB threshold)', () => {
		const value = { a: 1, b: 'two' };
		const wire = encode(value);
		expect(wire).toBe(JSON.stringify(value));
		expect(decode(wire)).toEqual(value);
	});

	test('force encodes below the threshold', () => {
		const value = { data: rows(2) };
		const wire = encode(value, { minBytes: 0, force: true });
		expect(decode(wire)).toEqual(value);
	});

	test('plain JSON is valid TRON', () => {
		const value = { data: rows(5), nested: { deep: [1, 2, 3] } };
		expect(decode(JSON.stringify(value))).toEqual(value);
	});

	test('strings with structural characters survive', () => {
		const value = {
			data: Array.from({ length: 50 }, (_, i) => ({
				id: i,
				s: `x(${i})],[",\\ y\nz\t"`,
				u: 'Δréssïng 👍'
			}))
		};
		expect(decode(encode(value, { minBytes: 0, force: true }))).toEqual(value);
	});

	test('empty / null / undefined edge cases', () => {
		expect(decode(encode([], { force: true }))).toEqual([]);
		expect(decode(encode(null, { force: true }))).toEqual(null);
		const v = { a: null, c: [null, 1] };
		expect(decode(encode(v, { force: true }))).toEqual(v);
	});

	test('wire is materially smaller than JSON on tabular data', () => {
		const value = { data: rows(500) };
		const wire = encode(value);
		expect(wire.length).toBeLessThan(JSON.stringify(value).length * 0.6);
	});
});

describe('Date handling (regression: used to encode as {})', () => {
	const when = new Date('2026-08-14T12:34:56.000Z');

	test('Date in a small object matches JSON.stringify semantics', () => {
		const wire = encode({ when }, { minBytes: 0, force: true });
		expect(decode(wire)).toEqual({ when: when.toJSON() });
	});

	test('Date column in uniform rows (fast table path)', () => {
		const value = {
			data: Array.from({ length: 100 }, (_, i) => ({
				id: i,
				when: new Date(when.getTime() + i * 1000)
			}))
		};
		const back = decode(encode(value, { minBytes: 0, force: true }));
		expect(back.data[3].when).toBe(new Date(when.getTime() + 3000).toJSON());
		expect(back.data).toHaveLength(100);
	});

	test('Date at root array of rows', () => {
		const value = Array.from({ length: 50 }, (_, i) => ({ i, when }));
		const back = decode(encode(value, { minBytes: 0, force: true }));
		expect(back.every((r) => r.when === when.toJSON())).toBe(true);
	});

	test('Date deep in irregular nesting (general path)', () => {
		const value = { a: { b: [{ when }, 'x', 7] }, data: rows(20) };
		const back = decode(encode(value, { minBytes: 0, force: true }));
		expect(back.a.b[0].when).toBe(when.toJSON());
	});

	test('custom toJSON is honored like JSON.stringify', () => {
		const custom = { toJSON: () => ({ resolved: true }) };
		const wire = encode({ custom, pad: rows(30) }, { minBytes: 0, force: true });
		expect(decode(wire).custom).toEqual({ resolved: true });
	});
});

describe('schema-preloaded mode', () => {
	const users = defineSchema({
		id: 'users.v1',
		fields: ['id', 'name', 'role', 'score', 'active'],
		enums: { role: ['admin', 'user'], active: [false, true] },
		path: '$.data'
	});

	test('roundtrip + peek', () => {
		const value = { meta: { n: 3 }, data: rows(3) };
		const wire = users.encode(value);
		expect(users.peek(wire)).toBe('users.v1');
		expect(users.decode(wire)).toEqual(value);
	});

	test('registry routes by tag', () => {
		const reg = createRegistry();
		// must mirror the emitting schema exactly, enums included — a dictionary
		// column is an integer on the wire and only the enum table maps it back
		reg.register({
			id: 'users.v1',
			fields: ['id', 'name', 'role', 'score', 'active'],
			enums: { role: ['admin', 'user'], active: [false, true] },
			path: '$.data'
		});
		const wire = users.encode({ data: rows(2) });
		expect(reg.decode(wire)).toEqual({ data: rows(2) });
		expect(() => reg.decode('#unknown.v9\n[]')).toThrow('unknown schema id');
	});

	test('numeric enum values are rejected', () => {
		expect(() => defineSchema({ fields: ['x'], enums: { x: [1, 2] } })).toThrow();
	});
});

describe('columnar mode', () => {
	test('numeric table decodes to a Float64Array tape', () => {
		const data = Array.from({ length: 100 }, (_, i) => ({ a: i, b: i * 2.5 }));
		const wire = encodeColumnar(data);
		const col = decodeColumnar(wire, true);
		// eligibility depends on the WASM scanner accepting the payload
		if (wasmAvailable()) {
			expect(col).toBeDefined();
			expect(col.cols).toBe(2);
			expect(col.rows).toBe(100);
			expect(col.tape[2 * 5 + 1]).toBe(12.5);
		}
		// the object path must read the same payload regardless
		expect(decode(wire)).toEqual(data);
	});
});

describe('wasm', () => {
	test('embedded binary initializes without any asset wiring', () => {
		expect(wasmAvailable()).toBe(true);
	});
});
