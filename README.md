# @human-synthesis/norns-tron

TRON serialization for the Norns ecosystem — a token-efficient, faster-than-JSON
wire format for APIs and LLM-facing output. Zero runtime dependencies.

TRON cuts **11–61% of tokens** vs JSON and, used correctly, beats
`JSON.parse` / `JSON.stringify` on decode, encode, and round-trip. Plain JSON is
valid TRON, so adoption is progressive and rollback is trivial. See
[PERFORMANCE.md](./PERFORMANCE.md) for measured numbers and usage guidance.

The encoder/decoder core is absorbed from the `apitron` research library; this
package adds the Norns framework glue as subpath exports.

```
@human-synthesis/norns-tron           encode / decode / defineSchema / registry
@human-synthesis/norns-tron/server    tronSerializer() for norns route()
@human-synthesis/norns-tron/client    api fetch wrapper that speaks TRON
@human-synthesis/norns-tron/valibot   derive wire schemas from valibot schemas
```

## Turn it on app-wide

```coffee
# src/hooks.server.c
import { boot } from '@human-synthesis/norns/server'
import { tronSerializer } from '@human-synthesis/norns-tron/server'

app := await boot
  features: import.meta.glob('./lib/*/server/module.c', eager: true)
  serializer: tronSerializer()
```

Every `route()` response is now content-negotiated: clients that send
`Accept: application/tron` get TRON, everyone else (curl, third parties,
existing code) keeps getting JSON. Nothing breaks. Remove the `serializer`
line to roll the whole thing back.

Per-route control:

```coffee
export GET  := route serializer: tronSerializer({ schema: noteWire }), handler: ...
export POST := route serializer: null, handler: ...   # force plain JSON
```

## Call it from the client

```coffee
import { api, createApi } from '@human-synthesis/norns-tron/client'

users := await api.get '/api/users'          # sends Accept: application/tron
await api.post '/api/notes', { title, body } # body goes out as TRON too

# inside a load function, keep SvelteKit's fetch semantics:
api := createApi { fetch }
```

The 1.7 KB WASM scanner ships embedded as base64 — no asset wiring, works in
Node, Bun, and the browser. Under a strict CSP without `unsafe-eval` the
decoder transparently falls back to the JS scanner (~1.1–1.5x).

## Schema mode — the fastest path for internal endpoints

Both ends already know the shape from the feature contract, so nothing
descriptive needs to travel. Derive the wire schema from the valibot schema
you already have in `shared/schema.c`:

```coffee
# src/lib/notes/shared/schema.c
import * as v from 'valibot'
import { tronSchemaFromValibot } from '@human-synthesis/norns-tron/valibot'

export noteSchema := v.object
  id: v.number()
  title: v.string()
  status: v.picklist ['draft', 'published']

export noteWire := tronSchemaFromValibot noteSchema, { id: 'notes.v1', path: '$.data' }
```

`picklist`/`enum` fields become dictionary columns (integers on the wire),
booleans become 0/1. Compile once at module scope — never per request.
The `#notes.v1` tag makes version mismatches fail loudly instead of
misdecoding; use `createRegistry()` on a client that consumes several shapes.

## Semantics and limits

- Same value semantics as JSON: `toJSON()` is honored, so a `Date` arrives as
  its ISO string (not a `Date` — same as `response.json()`). `Map`/`Set`
  serialize as `{}` and `BigInt` throws, exactly like `JSON.stringify`; dev
  mode logs a warning when a route returns them.
- **Not for `load` / form actions** — SvelteKit serializes those with devalue
  (which preserves Dates, Maps, Sets). This package targets `route()`
  endpoints, LLM-facing output, and service-to-service payloads.
- Payloads under ~1 KB are emitted as plain JSON automatically (still decoded
  transparently) — below that size TRON's fixed costs don't pay for themselves.
- The wire content type is `application/tron`, not `application/json`: a TRON
  body may carry a declaration preamble that is not valid JSON.
- Schema mode uses `new Function` for the row constructor (server-side this is
  a non-issue; in CSP-restricted browsers the fallback scanner takes over).

## Development

```sh
bun test              # 38 tests: core roundtrips, Date regression, server/client glue, valibot derivation
bun run embed-wasm    # regenerate src/core/wasm-bytes.js after replacing wasm/parserTron2.wasm
```

License: MIT.
