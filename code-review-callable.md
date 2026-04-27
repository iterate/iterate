# Callable Review

Reviewed current uncommitted changes in `packages/shared/src/callable/**`,
`packages/shared/package.json`, `packages/shared/tsconfig.json`, and
`pnpm-lock.yaml` against `jonasland/RULES.md`, Cloudflare Workers/Durable
Objects/WebSocket/RPC documentation, and Kenton Varda's Workers/Cap'n Web
writing.

## Findings

### 1. Wildcard package export makes the API surface too broad

`packages/shared/package.json` exports `./callable/*`, which makes tests,
fixtures, config, docs, and future implementation files importable package API.
This conflicts with the repo rule that API shape matters and should be
intentional.

Recommended fix: export exact stable subpaths only, such as
`./callable/runtime.ts` and `./callable/types.ts`, or remove package exports
until the first real consumer exists.

### 2. Runtime resolves arbitrary bindings from raw `env`

`dispatchCallableFetch` accepts raw `ctx.env`, and binding names from JSON are
looked up directly. That means an untrusted stored callable can ask for any
binding present on the worker unless the caller does external filtering.

This undercuts the docs' claim that a `Callable` is not itself a capability.
Kenton's Workers capability model treats bindings/stubs as live capabilities
that must be explicitly handed to code, not ambiently named by untrusted data.

Relevant sources:

- https://blog.cloudflare.com/workers-environment-live-object-bindings/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/
- https://developers.cloudflare.com/dynamic-workers/usage/bindings/

Recommended fix: replace raw `env` lookup with an explicit resolver/policy
object, or keep dispatch unexported/trusted-only until capability policy exists.

### 3. Public HTTP dispatch falls back to `globalThis.fetch`

`dispatchCallableFetch` uses `ctx.fetcher ?? globalThis.fetch`. For this shared
library, `jonasland/RULES.md` prefers explicit dependencies over globals.

Recommended fix: require `ctx.fetcher` for `target.type === "http"` and make
Worker boundaries pass `globalThis.fetch` explicitly.

### 4. Service/DO `upstream` looks like URL authority

For service and Durable Object targets, `upstream` is synthetic request URL
state, not network authority. The README says this, but the API shape still
encourages thinking of the binding target as URL-addressed.

Cloudflare service bindings and Durable Object stubs are capability objects; the
URL should not look like it grants access.

Relevant source:

- https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/

Recommended fix: keep absolute `upstream` only for HTTP targets. For service and
Durable Object targets, use `pathPrefix?: string` plus `pathMode`, with the
runtime choosing the synthetic origin internally.

### 5. Workers Vitest config writes files at import time

`src/callable/vitest.config.ts` creates and writes
`.wrangler/vitest/wrangler.jsonc` whenever the config is loaded. That makes a
test command mutate the source tree and hides the actual Wrangler config from
normal review.

Cloudflare's Workers Vitest integration supports committed Wrangler configs or
inline Miniflare configuration.

Relevant source:

- https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/

Recommended fix: commit a small static callable test Wrangler config, or use
inline Miniflare config. Avoid import-time file writes.

### 6. Test Durable Object migration uses legacy KV-backed class syntax

The generated Wrangler config uses `new_classes` with
`new_sqlite_classes: []`. Cloudflare currently recommends SQLite-backed Durable
Object namespaces for new classes.

Relevant source:

- https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/

Recommended fix: use `new_sqlite_classes: ["CallableTestDurableObject"]`.

### 7. Invalid Durable Object IDs escape as platform exceptions

`idFromString()` can throw when the id is invalid or not from the namespace.
The schema only checks non-empty strings, so malformed ids will escape as raw
platform errors rather than `CallableError`.

Relevant source:

- https://developers.cloudflare.com/durable-objects/api/namespace/#idfromstring

Recommended fix: catch `idFromString()` failures, wrap them in
`CallableError("RESOLUTION_FAILED", ...)`, and add a Workers test.

### 8. Request template path behavior adds a surprising slash

`buildCallableRequest` uses the proxy path-prefix helper with a synthetic `/`,
so `https://api.example.com/tools` becomes `https://api.example.com/tools/`.
For request templates, an upstream path should probably be exact unless a path
template exists.

Recommended fix: build template URLs directly from `target.upstream`, and expect
`https://api.example.com/tools?dryRun=true`.

### 9. Callable tests are not part of normal shared package test

`packages/shared` now has `test:callable`, but the default `test` script still
runs only the existing node test. Root `pnpm test` will miss callable behavior.

Recommended fix: split `test:node`, and make `test` run both `test:node` and
`test:callable`.

### 10. Future RPC/task language drifts away from Workers RPC

`tasks/rpc.md` talks about explicit method strings and object/positional args.
That sounds closer to JSON-RPC than Workers' native Cap'n Web-flavored RPC,
where callers use typed stubs and pass structured-clone values, functions, and
`RpcTarget`s by reference.

Relevant sources:

- https://blog.cloudflare.com/javascript-native-rpc/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/
- https://github.com/cloudflare/capnweb

Recommended fix: rewrite the RPC task around resolving live RPC stubs and using
native Workers RPC. Treat method-string invocation as an adapter for untyped
tool manifests, not the core RPC model.

### 11. Future tool/subscription tasks should be capability-first

The tool-provider and event-subscription task notes lean toward list/call
descriptors and custom WebSocket frames. Kenton's Cap'n Web framing points
toward passing restricted stubs/functions by reference, returning disposable
subscription objects, and using custom frame protocols only at public edges.

Relevant sources:

- https://gitnation.com/contents/no-rest-for-capn-web
- https://github.com/cloudflare/capnweb
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/#duplicate-stubs-in-rpc-params-instead-of-transferring-ownership

Recommended fix: update task language so tools/subscriptions are
capability-first APIs, with JSON/WebSocket framing treated as adapters.

### 12. Prior-art docs need first-party links

The README/tasks mention Caddy, Envoy, and NGINX path behavior without links.
The repo rules ask for first-party links when explaining configuration fences.

Recommended fix: add links in `tasks/path-rewrites.md`:

- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto.html
- https://nginx.org/en/docs/http/ngx_http_proxy_module.html

## Verification Seen

- `pnpm --dir packages/shared typecheck` passed
- `pnpm --dir packages/shared test:callable` passed
- `pnpm --dir packages/shared test` passed

## Plan (TODO)
