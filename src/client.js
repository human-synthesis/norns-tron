/**
 * Client fetch wrapper that speaks TRON with a norns `route()` endpoint.
 *
 *   import { api } from '@human-synthesis/norns-tron/client';
 *   const users = await api.get('/api/users');
 *   await api.post('/api/notes', { title, body });
 *
 * In a load function, pass SvelteKit's fetch so relative URLs and SSR
 * de-duplication keep working:
 *   const api = createApi({ fetch });
 *
 * The WASM scanner ships embedded (~2.3 KB base64) and initializes lazily, so
 * no asset wiring is needed in the browser. Under a strict CSP without
 * `unsafe-eval` the decoder transparently falls back to the JS scanner.
 */
import { decode, encode } from './index.js';

export const TRON_CONTENT_TYPE = 'application/tron';
const ACCEPT = 'application/tron, application/json;q=0.9, */*;q=0.1';

export class ApiError extends Error {
	/**
	 * @param {number} status
	 * @param {any} body decoded error body (message/issues from route())
	 * @param {Response} response
	 */
	constructor(status, body, response) {
		super(body?.message ?? `HTTP ${status}`);
		this.name = 'ApiError';
		this.status = status;
		this.body = body;
		this.response = response;
	}
}

/** Decode a Response by its content-type (TRON, JSON, or raw text). */
export async function parseResponse(res) {
	if (res.status === 204) return null;
	const type = res.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
	const text = await res.text();
	if (text === '') return null;
	if (type === TRON_CONTENT_TYPE) return decode(text);
	if (type === 'application/json' || type.endsWith('+json')) return JSON.parse(text);
	return text;
}

/**
 * @param {object} [defaults]
 * @param {typeof fetch} [defaults.fetch] fetch impl (pass SvelteKit's in load functions)
 * @param {string} [defaults.base] URL prefix, e.g. 'https://api.example.com'
 * @param {Record<string, string>} [defaults.headers] headers sent on every request
 */
export function createApi(defaults = {}) {
	const base = defaults.base ?? '';

	async function request(method, url, body, opts = {}) {
		// Resolve fetch per call: in the browser `globalThis.fetch` must not be
		// captured at module-import time (SSR would freeze the server's fetch).
		const doFetch = opts.fetch ?? defaults.fetch ?? globalThis.fetch;
		const headers = { accept: ACCEPT, ...defaults.headers, ...opts.headers };
		/** @type {RequestInit} */
		const init = { method, headers, ...opts.init };
		if (body !== undefined) {
			// encode() emits plain JSON under 1 KB — still valid TRON, and the
			// server's parseBody reads both, so the content type stays stable.
			headers['content-type'] = TRON_CONTENT_TYPE;
			init.body = encode(body);
		}
		const res = await doFetch(base + url, init);
		const parsed = await parseResponse(res);
		if (!res.ok) throw new ApiError(res.status, parsed, res);
		return parsed;
	}

	return {
		request,
		get: (url, opts) => request('GET', url, undefined, opts),
		del: (url, opts) => request('DELETE', url, undefined, opts),
		post: (url, body, opts) => request('POST', url, body, opts),
		put: (url, body, opts) => request('PUT', url, body, opts),
		patch: (url, body, opts) => request('PATCH', url, body, opts)
	};
}

/** Default instance for browser code. In load functions use createApi({ fetch }). */
export const api = createApi();
