import type { CompiledSchema, SchemaSpec } from './index.js';

export interface DeriveOptions {
	/** Version tag emitted as a `#id` line and used by createRegistry(). */
	id?: string;
	/** Where the row array lives: `'$'` (root) or e.g. `'$.data'`. */
	path?: string;
}

/** Derive a plain TRON schema spec from a valibot v.object(...) schema. */
export function tronSpecFromValibot(objectSchema: unknown, opts?: DeriveOptions): SchemaSpec;

/** Derive and compile in one step. Call at module scope, never per request. */
export function tronSchemaFromValibot(objectSchema: unknown, opts?: DeriveOptions): CompiledSchema;
