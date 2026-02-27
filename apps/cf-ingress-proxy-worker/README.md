# ingress-proxy worker

`apps/cf-ingress-proxy-worker` is a tiny programmable ingress proxy on Cloudflare Workers.

It maps inbound host patterns to upstream targets stored in D1, then forwards HTTP/WebSocket traffic transparently.

## Why this exists

For ephemeral environments (E2E runs, agent sandboxes, preview stacks), we need many public hostnames quickly without provisioning per-host DNS + TLS each time.

Pattern:

```text
*.ingress.iterate.com CNAME -> ingress-proxy worker
```

With wildcard DNS/TLS already available in Cloudflare, this also works for CNAME-driven setups and future subdomain patterns like iterate.app project hostnames.

## Design constraints

- Transparent by default: preserve inbound `Host`, headers, body stream, and WebSocket upgrades.
- Optional per-pattern header overrides for exceptional auth/routing cases.
- Hostname tokens are opaque: this service does not interpret `__`, ports, or service names.
- Conflict-safe writes: duplicate patterns across different routes are rejected with typed conflict errors.

## Data model

Two tables:

- `routes`
  - route group metadata
  - stable external `routeId` (typeid)
- `route_patterns`
  - child rows for each pattern -> target (+ optional headers)
  - `ON DELETE CASCADE`

## Admin API (oRPC)

All endpoints require `Authorization: Bearer <INGRESS_PROXY_API_TOKEN>`.

- `createRoute`
- `updateRoute`
- `deleteRoute`
- `getRoute`
- `listRoutes`

`createRoute`/`updateRoute` accept:

- `metadata?: Record<string, unknown>`
- `patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>`

## Env validation

`env.ts` declares the worker env contract using Zod and throws on invalid config.

- required: `DB`, `INGRESS_PROXY_API_TOKEN`
- defaulted (non-secret): `TYPEID_PREFIX` (default `ipr`)

`manifest.ts` exports:

- `name: "ingress-proxy"`
- required env schema

## Deploy

Alchemy manages worker + D1 resources.

- worker name: `ingress-proxy`
- D1 name: `ingress-proxy-routes` (prod)
- D1 schema applied via `migrations/`

## Tests

- SQLite-backed unit tests for conflict/matching internals.
- E2E-style worker tests for API and proxy behavior.

## TODO (explicitly deferred)

Pattern lookup optimization is intentionally deferred. Current matching prioritizes correctness and simplicity; optimize query narrowing later if route cardinality warrants it.
