import { describe, expect, test } from 'bun:test';
import { createApi, parseResponse, ApiError, TRON_CONTENT_TYPE } from '../src/client.js';
import { encode, decode } from '../src/index.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i, name: 'u' + i, role: 'user' }));

function stubFetch(handler) {
	const calls = [];
	const fetcher = async (url, init) => {
		calls.push({ url, init });
		return handler(url, init ?? {});
	};
	fetcher.calls = calls;
	return fetcher;
}

describe('createApi', () => {
	test('sends the TRON Accept header and decodes a TRON response', async () => {
		const value = { data: rows(200) };
		const fetch = stubFetch(
			() => new Response(encode(value), { headers: { 'content-type': TRON_CONTENT_TYPE } })
		);
		const api = createApi({ fetch });
		expect(await api.get('/api/users')).toEqual(value);
		expect(fetch.calls[0].init.headers.accept).toContain('application/tron');
	});

	test('decodes a plain JSON response transparently', async () => {
		const fetch = stubFetch(
			() => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
		);
		const api = createApi({ fetch });
		expect(await api.get('/x')).toEqual({ ok: true });
	});

	test('POST bodies go out as TRON the server can decode', async () => {
		const sent = { title: 'note', tags: ['a', 'b'] };
		const fetch = stubFetch(
			(url, init) =>
				new Response(JSON.stringify({ echoed: decode(init.body) }), {
					headers: { 'content-type': 'application/json' }
				})
		);
		const api = createApi({ fetch });
		const res = await api.post('/api/notes', sent);
		expect(res.echoed).toEqual(sent);
		expect(fetch.calls[0].init.headers['content-type']).toBe(TRON_CONTENT_TYPE);
	});

	test('non-ok responses throw ApiError with the decoded body', async () => {
		const fetch = stubFetch(
			() =>
				new Response(JSON.stringify({ message: 'nope', issues: [{ path: 'title' }] }), {
					status: 400,
					headers: { 'content-type': 'application/json' }
				})
		);
		const api = createApi({ fetch });
		try {
			await api.post('/x', {});
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ApiError);
			expect(e.status).toBe(400);
			expect(e.body.message).toBe('nope');
		}
	});

	test('base prefix and 204 handling', async () => {
		const fetch = stubFetch(() => new Response(null, { status: 204 }));
		const api = createApi({ fetch, base: 'https://api.test' });
		expect(await api.del('/thing/1')).toBeNull();
		expect(fetch.calls[0].url).toBe('https://api.test/thing/1');
	});
});

describe('parseResponse', () => {
	test('falls back to text for unknown content types', async () => {
		expect(await parseResponse(new Response('hello', { headers: { 'content-type': 'text/plain' } }))).toBe('hello');
	});
});
