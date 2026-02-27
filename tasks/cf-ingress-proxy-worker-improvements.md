---
state: in-progress
priority: medium
size: large
---

# cf-ingress-proxy-worker improvements

Rewrite the cf-ingress-proxy-worker to be a clean, minimal, transparent proxy worthy of being a showcase CF Workers project. Add comprehensive E2E tests.

## Context

The cf-ingress-proxy-worker is a programmable ingress proxy on Cloudflare Workers. It stores hostname→target mappings in D1 and proxies requests. It was originally vibe-coded and needs a proper rewrite.

Goal: Kent C. Dodds / Barda-quality code. Minimal, transparent, zero unnecessary overhead on the request path.

## Phase 1: Transparent proxy + in-memory caching (request path performance)

The hot path (every proxied request) currently does:

1. `ensureSchema()` — runs CREATE TABLE + 4x ALTER TABLE + 3x CREATE INDEX on **every request**
2. D1 query for exact match
3. D1 query for ALL wildcard rows, then filter in JS
4. Header rewriting
5. `fetch()` to upstream

**Changes:**

### 1a. Remove `ensureSchema()` from the request path

- Run schema migration once at deploy time or via admin API endpoint
- The proxy path should never touch DDL

### 1b. `setRoute` conflict detection (`onConflict` parameter)

Currently `setRoute` silently upserts — if a route already exists, it overwrites. Add an `onConflict` parameter:

- `"fail"` (default) — reject with error if route already exists with a different target/config
- `"overwrite"` — current upsert behavior

This prevents accidental route collisions. Since callers are trusted (only our control plane + tests), this is a safety net, not a security boundary.

### 1c. Transparent WebSocket support

CF Workers `fetch()` natively supports WebSocket upgrades when you pass the original request through. The current code does:

```ts
const body = method === "GET" || method === "HEAD" ? undefined : request.body;
const upstreamResponse = await fetch(
  new Request(upstreamUrl, { method, headers, body, redirect: "manual" }),
);
```

This strips the original request's WebSocket upgrade context. Instead:

```ts
return fetch(new Request(upstreamUrl, request));
```

This passes the entire request (including upgrade headers, body stream, etc.) transparently. The runtime handles WebSocket lifecycle with zero per-message overhead.

**Key insight:** `return fetch(new Request(newUrl, request))` handles both HTTP and WebSocket transparently. No `WebSocketPair` needed for a pass-through proxy.

**Caveats:**

- Must use `https://` not `wss://` in the fetch URL
- WebSocket idle timeout: 100s via CF CDN — may need heartbeat awareness
- Max message size: 32 MiB

## Phase 2: Code cleanup — single file, < 500 lines

**Constraint:** Everything stays in one file (`server.ts`). Target < 500 lines total. If it's more, we failed.

### 2a. Remove unnecessary abstractions

- `InputError` class → just use `ORPCError` directly
- `parseJsonObject` → D1 already stores/returns JSON text, simplify
- `rowToRouteRecord` → consider whether the camelCase transform is worth the complexity

### 2b. Clean up schema management

- Single migration function, called from admin API or deploy script
- Not called on every request

## Phase 3: README + documentation

### 3a. Rewrite README

- Clear explanation of the architecture and why it exists
- ASCII/mermaid diagram showing: Client → CF Worker (proxy) → Fly.io → Caddy → App
- Document the wildcard pattern: `*.ingress.iterate.com` CNAME → worker, then routes like `anything.ingress.iterate.com` → target
- Concrete examples

### 3b. Inline code comments

- Keep minimal but explain non-obvious choices (e.g. why global var cache is fine)

## Phase 4: Tests

**Strategy:** All tests are E2E tests against the live worker, except unit tests for route matching logic (exact vs wildcard priority, suffix sorting, etc.).

Model after the JonasLand E2E test suite.

### 4a. Unit tests (route matching only)

- Exact match wins over wildcard
- Longer wildcard suffix wins over shorter
- Expired routes don't match
- `onConflict: "fail"` rejects duplicate routes

### 4b. E2E test infrastructure

- Vitest test runner
- The test takes as input:
  - `CF_PROXY_WORKER_URL` — publicly routable hostname for the proxy
  - `CF_PROXY_WORKER_API_TOKEN` — access token for admin API
- For WebSocket testing: spin up a local server, expose via `cloudflared tunnel --protocol http2`
- Tests register routes via admin API, then make requests through the proxy

### 4c. E2E test cases

- **HTTP proxy:** Register route → request through proxy → verify response
- **Header rewriting:** Verify Host header and custom headers reach upstream
- **Wildcard routing:** Register `*.pattern` → verify subdomain requests route correctly
- **Exact vs wildcard priority:** Both registered → exact wins
- **WebSocket proxy:** Open WS connection through proxy → send/receive messages → verify bidirectional
- **WebSocket latency:** Measure round-trip time through proxy, output stats
- **TTL expiration:** Register route with TTL → wait → verify expired
- **404 on no match:** Request unregistered hostname → 404
- **Admin API auth:** Verify unauthorized requests are rejected
- **Large payloads:** Proxy large HTTP bodies
- **Concurrent connections:** Multiple simultaneous requests/WS connections

### 4c. Stats output

At test end, print:

- HTTP proxy latency (p50, p95, p99)
- WebSocket round-trip latency (p50, p95, p99)
- Number of routes tested
- Any failures/anomalies

## Open questions

1. **Schema migration strategy:** Should we have an explicit `/admin/migrate` endpoint? Or rely on Wrangler migrations? D1 supports migrations via `wrangler d1 migrations`.

2. **Wildcard matching complexity:** Currently supports `*.suffix` only. Do we need more complex patterns (e.g. regex, path-based routing)? Probably not — keep it simple.

3. **Test environment:** Do we run E2E tests against the production proxy worker, or deploy a staging instance? Need a `*.ingress.iterate.com` wildcard cert + CNAME in place for tests to work.

4. **Should the proxy strip/add any security headers?** Currently passes everything through transparently. May want to set `X-Forwarded-For`, `X-Forwarded-Proto`, etc.

5. **How should we handle the case where upstream is down?** Currently returns 502 with `proxy_error`. Should we add retry logic or keep it simple?
