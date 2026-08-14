export const TRON_CONTENT_TYPE: 'application/tron';

export class ApiError extends Error {
	status: number;
	body: unknown;
	response: Response;
}

/** Decode a Response by its content-type (TRON, JSON, or raw text). */
export function parseResponse(res: Response): Promise<unknown>;

export interface ApiDefaults {
	/** fetch impl — pass SvelteKit's `fetch` inside load functions. */
	fetch?: typeof fetch;
	/** URL prefix, e.g. 'https://api.example.com'. */
	base?: string;
	/** Headers sent on every request. */
	headers?: Record<string, string>;
}

export interface RequestOptions {
	fetch?: typeof fetch;
	headers?: Record<string, string>;
	init?: RequestInit;
}

export interface Api {
	request(method: string, url: string, body?: unknown, opts?: RequestOptions): Promise<any>;
	get(url: string, opts?: RequestOptions): Promise<any>;
	del(url: string, opts?: RequestOptions): Promise<any>;
	post(url: string, body?: unknown, opts?: RequestOptions): Promise<any>;
	put(url: string, body?: unknown, opts?: RequestOptions): Promise<any>;
	patch(url: string, body?: unknown, opts?: RequestOptions): Promise<any>;
}

export function createApi(defaults?: ApiDefaults): Api;

/** Default instance for browser code. In load functions use createApi({ fetch }). */
export const api: Api;
