import { describe, expect, test } from 'bun:test';
import { tronSerializer, acceptsTron, TRON_CONTENT_TYPE } from '../src/server.js';
import { decode, defineSchema } from '../src/index.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i, name: 'u' + i, role: 'user' }));

const eventFor = (accept) => ({
	request: new Request('http://test/api/x', accept ? { headers: { accept } } : {}),
	url: new URL('http://test/api/x')
});

describe('tronSerializer.serialize', () => {
	test('returns null (JSON fallthrough) when client did not ask for TRON', () => {
		const s = tronSerializer();
		expect(s.serialize({ data: rows(100) }, eventFor(null))).toBeNull();
		expect(s.serialize({ data: rows(100) }, eventFor('application/json'))).toBeNull();
	});

	test('encodes when Accept includes application/tron', async () => {
		const s = tronSerializer();
		const value = { data: rows(200) };
		const res = s.serialize(value, eventFor('application/tron, application/json;q=0.9'));
		expect(res).toBeInstanceOf(Response);
		expect(res.headers.get('content-type')).toBe(TRON_CONTENT_TYPE);
		expect(decode(await res.text())).toEqual(value);
	});

	test('small results ship as plain JSON body under the same content type', async () => {
		const s = tronSerializer();
		const res = s.serialize({ ok: true }, eventFor('application/tron'));
		const text = await res.text();
		expect(text).toBe('{"ok":true}'); // valid TRON, cheap for tiny payloads
		expect(decode(text)).toEqual({ ok: true });
	});

	test('null/undefined results encode as null', async () => {
		const s = tronSerializer();
		const res = s.serialize(null, eventFor('application/tron'));
		expect(decode(await res.text())).toBeNull();
	});

	test('schema mode skips shape detection and tags the wire', async () => {
		const users = defineSchema({
			id: 'users.v1',
			fields: ['id', 'name', 'role'],
			enums: { role: ['admin', 'user'] },
			path: '$.data'
		});
		const s = tronSerializer({ schema: users });
		const value = { data: rows(3) };
		const res = s.serialize(value, eventFor('application/tron'));
		const text = await res.text();
		expect(text.startsWith('#users.v1\n')).toBe(true);
		expect(users.decode(text)).toEqual(value);
	});
});

describe('tronSerializer.parseBody', () => {
	test('reads a TRON request body', async () => {
		const s = tronSerializer();
		const body = '{"title":"hi","n":2}'; // plain JSON is valid TRON
		const req = new Request('http://test/', {
			method: 'POST',
			headers: { 'content-type': TRON_CONTENT_TYPE },
			body
		});
		expect(await s.parseBody(req, TRON_CONTENT_TYPE)).toEqual({ title: 'hi', n: 2 });
	});

	test('returns undefined for other content types (fallthrough to route defaults)', () => {
		const s = tronSerializer();
		const req = new Request('http://test/', { method: 'POST', body: '{}' });
		expect(s.parseBody(req, 'application/json')).toBeUndefined();
	});

	test('malformed body resolves to null, like the JSON reader', async () => {
		const s = tronSerializer();
		const req = new Request('http://test/', {
			method: 'POST',
			headers: { 'content-type': TRON_CONTENT_TYPE },
			body: 'class C0: broken\n{{{'
		});
		expect(await s.parseBody(req, TRON_CONTENT_TYPE)).toBeNull();
	});
});

describe('acceptsTron', () => {
	test('header matching', () => {
		expect(acceptsTron(new Request('http://t/', { headers: { accept: 'application/tron' } }))).toBe(true);
		expect(acceptsTron(new Request('http://t/', { headers: { accept: 'text/html' } }))).toBe(false);
		expect(acceptsTron(new Request('http://t/'))).toBe(false);
	});
});
