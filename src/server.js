/**
 * Server glue for Norns `route()`.
 *
 * Usage (app-wide):
 *   // src/hooks.server.c (or wherever boot() runs)
 *   import { setSerializer } from '@human-synthesis/norns/server';
 *   import { tronSerializer } from '@human-synthesis/norns-tron/server';
 *   setSerializer(tronSerializer());
 *
 * Per-route override / opt-out:
 *   export const POST = route({ serializer: null, handler });          // plain JSON
 *   export const GET  = route({ serializer: tronSerializer({ schema }), handler });
 *
 * The serializer only kicks in when the client asked for TRON via the Accept
 * header, so curl, third parties and existing consumers keep getting JSON.
 * Plain JSON is valid TRON, so clients may also send TRON request bodies
 * unconditionally — `parseBody` reads both.
 */
import { encode, decode } from './index.js';

export const TRON_CONTENT_TYPE = 'application/tron';

/** True when the request's Accept header asks for TRON. */
export function acceptsTron(request) {
	const accept = request.headers.get('accept');
	return accept !== null && accept.includes(TRON_CONTENT_TYPE);
}

const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
const warned = new Set();

// Cheap capped walk: Map/Set/BigInt silently degrade in any JSON-family
// format (Map/Set -> {}, BigInt throws). json() has the same problem, but a
// dev-time nudge here beats debugging a mangled payload. Dates are fine —
// they encode as ISO strings, exactly like JSON.stringify.
function devWarn(value, path) {
	let budget = 200;
	(function walk(v, p) {
		if (budget-- <= 0 || v === null || typeof v !== 'object') {
			if (typeof v === 'bigint' && !warned.has(p)) {
				warned.add(p);
				console.warn(`[norns-tron] ${p}: BigInt cannot be serialized (same as JSON) — convert to string/number`);
			}
			return;
		}
		if ((v instanceof Map || v instanceof Set) && !warned.has(p)) {
			warned.add(p);
			console.warn(`[norns-tron] ${p}: ${v.constructor.name} serializes as {} (same as JSON) — convert to array/object first`);
			return;
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length && budget > 0; i++) walk(v[i], p);
			return;
		}
		for (const k of Object.keys(v)) { if (budget <= 0) break; walk(v[k], p + '.' + k); }
	})(value, path);
}

/**
 * Build a serializer for norns `route()` / `setSerializer()`.
 *
 * @param {object} [opts]
 * @param {{encode:Function, decode:Function}} [opts.schema] compiled schema from
 *        defineSchema() — skips shape detection entirely (fastest mode)
 * @param {number}  [opts.minBytes] below this JSON size, emit plain JSON (default 1024)
 * @param {boolean} [opts.dict]     dictionary-encode low-cardinality columns (default true)
 * @param {boolean|'nested'} [opts.table] emit table declarations (default true)
 * @returns {{serialize: Function, parseBody: Function}}
 */
export function tronSerializer(opts = {}) {
	const { schema, ...encodeOpts } = opts;
	return {
		/** @returns {Response|null} null = fall through to json() */
		serialize(result, event) {
			if (!acceptsTron(event.request)) return null;
			const value = result ?? null;
			if (DEV) devWarn(value, event.url?.pathname ?? '$');
			const body = schema ? schema.encode(value) : encode(value, encodeOpts);
			return new Response(body, {
				headers: { 'content-type': TRON_CONTENT_TYPE }
			});
		},

		/** @returns {Promise<any>|undefined} undefined = content type not handled */
		parseBody(request, contentType) {
			if (contentType !== TRON_CONTENT_TYPE) return undefined;
			return request.text().then(
				(text) => {
					try {
						return decode(text);
					} catch {
						return null; // schema validation then rejects, same as malformed JSON
					}
				},
				() => null
			);
		}
	};
}
