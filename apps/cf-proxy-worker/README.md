# cf-proxy-worker

Transparent ingress proxy on Cloudflare Workers. Gives any backend instant public hostnames — no DNS propagation, no certificate provisioning, no waiting.

## The problem

You have a single server (e.g. a Fly.io machine) running multiple apps behind Caddy. You need many publicly routable hostnames to reach it — one per app, per test run, per environment. Normally this means:

1. Create a DNS record per hostname
2. Wait for propagation
3. Provision TLS certificates
4. Wait for certificate issuance

This takes minutes to hours and doesn't scale for ephemeral environments like E2E test runs.

## The solution

One wildcard DNS record + one wildcard TLS certificate + this proxy worker.

```
*.proxy.iterate.com  CNAME → cf-proxy-worker (Cloudflare Worker)
```

Now any `<anything>.proxy.iterate.com` hostname hits this worker. The worker looks up a route table to decide where to forward the request. Routes are managed via an authenticated API.

```
                          Client
                            │
                            │  https://myapp.proxy.iterate.com/api/health
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Cloudflare Edge                                │
│                                                                      │
│  *.proxy.iterate.com  ─►  cf-proxy-worker                            │
│                                                                      │
│     1. Extract Host header (myapp.proxy.iterate.com)                 │
│     2. Look up route (in-memory cache → D1 fallback)                 │
│     3. Forward request transparently (HTTP + WebSocket)              │
│                                                                      │
│  Admin API: /api/orpc/{listRoutes, setRoute, deleteRoute}            │
│                                                                      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │      Fly.io machine      │
                  │                          │
                  │   ┌──────────────────┐   │
                  │   │      Caddy       │   │
                  │   │  routes by Host  │   │
                  │   └──┬─────┬─────┬───┘   │
                  │      │     │     │        │
                  │      ▼     ▼     ▼        │
                  │    app1  app2  app3        │
                  └─────────────────────────┘
```

The proxy is fully transparent — it forwards HTTP requests, WebSocket connections, and streaming bodies without inspecting or modifying payloads. CF Workers `fetch()` handles WebSocket upgrades natively with zero per-message overhead.

## How routes work

### Exact routes

```ts
await client.setRoute({
  route: "myapp.proxy.iterate.com",
  target: "https://my-fly-app.fly.dev",
  headers: { host: "myapp.proxy.iterate.com" },
  ttlSeconds: 3600,
});
```

Requests to `myapp.proxy.iterate.com` are forwarded to `my-fly-app.fly.dev` with the `Host` header overridden. The route auto-expires after 1 hour.

### Wildcard routes

```ts
await client.setRoute({
  route: "*.proxy.iterate.com",
  target: "https://my-fly-app.fly.dev",
});
```

Now `anything.proxy.iterate.com` routes to your Fly app. Exact matches always take priority over wildcards, and longer wildcard suffixes take priority over shorter ones.

### Route lifecycle

- `ttlSeconds` — optional auto-expiration
- `status` — `active` | `expired` | `disabled`
- Expired routes are lazily marked on next lookup attempt

## Admin API

All endpoints require `Authorization: Bearer <CF_PROXY_WORKER_API_TOKEN>`.

| Endpoint | Description |
|---|---|
| `setRoute` | Create or update a route (upsert) |
| `deleteRoute` | Remove a route |
| `listRoutes` | List all routes |

### Client setup

```ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

const client = createORPCClient(
  new RPCLink({
    url: "https://<worker-domain>/api/orpc/",
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          authorization: `Bearer ${process.env.CF_PROXY_WORKER_API_TOKEN}`,
        },
      }),
  }),
);
```

### Concrete example: E2E test with two apps

```ts
// One Fly machine, two logical apps
await client.setRoute({
  route: "app1__run123.proxy.iterate.com",
  target: "https://someapp.fly.dev",
  headers: { host: "app1__run123.proxy.iterate.com" },
  metadata: { testRun: "run123", app: "app1" },
  ttlSeconds: 3600,
});

await client.setRoute({
  route: "app2__run123.proxy.iterate.com",
  target: "https://someapp.fly.dev",
  headers: { host: "app2__run123.proxy.iterate.com" },
  metadata: { testRun: "run123", app: "app2" },
  ttlSeconds: 3600,
});

// Both hostnames hit the same Fly machine.
// Caddy inside reads the Host header and routes to the right app.
```

## Schema

`routes` table (D1/SQLite):

| Column | Type | Description |
|---|---|---|
| `route` | TEXT PK | Hostname pattern (`app.proxy.iterate.com` or `*.proxy.iterate.com`) |
| `target` | TEXT | Upstream URL |
| `headers` | TEXT (JSON) | Header overrides for upstream request |
| `metadata` | TEXT (JSON) | Arbitrary metadata (test run ID, app name, etc.) |
| `status` | TEXT | `active` / `expired` / `disabled` |
| `ttl_seconds` | INTEGER | Optional TTL in seconds |
| `expires_at` | TEXT | Computed expiration timestamp |
| `expired_at` | TEXT | When the route was marked expired |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Last update timestamp |

## Run / deploy

```bash
# Local dev
pnpm --filter @iterate-com/cf-proxy-worker dev

# Deploy to production
pnpm --filter @iterate-com/cf-proxy-worker deploy:prd

# Unit tests
pnpm --filter @iterate-com/cf-proxy-worker test
```
