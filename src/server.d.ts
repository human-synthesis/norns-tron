import type { CompiledSchema, EncodeOptions } from './index.js';

export const TRON_CONTENT_TYPE: 'application/tron';

/** True when the request's Accept header asks for TRON. */
export function acceptsTron(request: Request): boolean;

export interface Serializer {
	serialize(result: unknown, event: { request: Request; url?: URL }): Response | null;
	parseBody(request: Request, contentType: string): Promise<unknown> | undefined;
}

export interface TronSerializerOptions extends EncodeOptions {
	/** Compiled schema from defineSchema() — skips shape detection (fastest mode). */
	schema?: CompiledSchema;
}

/** Build a serializer for norns route() / setSerializer() / boot({ serializer }). */
export function tronSerializer(opts?: TronSerializerOptions): Serializer;
