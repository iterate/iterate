# cf-ingress-proxy-worker

Transparent ingress proxy on Cloudflare Workers. Gives any backend instant public hostnames — no DNS propagation, no certificate provisioning, no waiting.

We built this for [Iterate](https://iterate.com) deployments, but the pattern is useful for any system that needs on-demand public URLs — coding agents, AI agent sandboxes, ephemeral preview environments, etc.

## The problem

You have a single server (e.g. a Fly.io machine) running multiple apps behind Caddy. You need many publicly routable hostnames to reach it — one per app, per port, per test run. Normally this means:

1. Create a DNS record per hostname
2. Wait for propagation
3. Provision TLS certificates
4. Wait for certificate issuance

This takes minutes to hours and doesn't scale for ephemeral environments like E2E test runs.

An alternative is tunnel services (ngrok, Cloudflare Tunnel, localtunnel) where each service gets a random public hostname. This works for one-off use, but breaks down at scale — you can't spin up dozens of concurrent tunnels for parallel E2E test runs without hitting connection limits, rate limits, and per-tunnel overhead.

In production, we provision proper wildcard certificates and CNAME records per project. But in testing, we need hostnames that spin up and tear down in milliseconds. That's what this worker does.

## The solution

One wildcard DNS record + one wildcard TLS certificate + this proxy worker.

```
*.ingress.iterate.com  CNAME → cf-ingress-proxy-worker (Cloudflare Worker)
```

Now any `<anything>.ingress.iterate.com` hostname hits this worker. The worker looks up a route table to decide where to forward the request. Routes are managed via an authenticated API.

```
                          Client
                            │
                            │  https://webapp__my-project.ingress.iterate.com/api/health
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Cloudflare Edge                                │
│                                                                      │
│  *.ingress.iterate.com  ─►  cf-ingress-proxy-worker                    │
│                                                                      │
│     1. Extract Host header                                           │
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
                  │    :3000 :4096 :8080       │
                  └─────────────────────────┘
```

The proxy is fully transparent — it forwards HTTP requests, WebSocket connections, and streaming bodies without inspecting or modifying payloads. CF Workers `fetch()` handles WebSocket upgrades natively with zero per-message overhead.

## How routes work

### Hostname conventions

In Iterate deployments, hostnames follow the pattern `<app-or-port>__<project-slug>.ingress.iterate.com`:

- `webapp__my-project.ingress.iterate.com` — route to the webapp service
- `3000__my-project.ingress.iterate.com` — route to port 3000
- `4096__my-project.ingress.iterate.com` — route to the OpenCode API on port 4096

Caddy inside the Fly machine reads the `Host` header and routes to the right process/port.

### Exact routes

```ts
await client.setRoute({
  route: "webapp__my-project.ingress.iterate.com",
  target: "https://prd-my-project.fly.dev",
  headers: { host: "webapp__my-project.ingress.iterate.com" },
  ttlSeconds: 3600,
});
```

### Wildcard routes

```ts
// Route all subdomains for a project to its Fly machine
await client.setRoute({
  route: "*.my-project.ingress.iterate.com",
  target: "https://prd-my-project.fly.dev",
});
```

Now `webapp__my-project.ingress.iterate.com`, `3000__my-project.ingress.iterate.com`, etc. all route to the same Fly machine. Caddy inside differentiates by Host header.

Exact matches always take priority over wildcards. Longer wildcard suffixes take priority over shorter ones.

### Route lifecycle

- `ttlSeconds` — optional auto-expiration
- `status` — `active` | `expired` | `disabled`
- Expired routes are lazily marked on next lookup attempt

## Admin API

All endpoints require `Authorization: Bearer <CF_PROXY_WORKER_API_TOKEN>`.

| Endpoint      | Description                       |
| ------------- | --------------------------------- |
| `setRoute`    | Create or update a route (upsert) |
| `deleteRoute` | Remove a route                    |
| `listRoutes`  | List all routes                   |

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

### Concrete example: E2E test with multiple services

```ts
const projectSlug = "my-project";
const flyTarget = "https://prd-my-project.fly.dev";

// Route different apps/ports to the same Fly machine
await client.setRoute({
  route: `webapp__${projectSlug}.ingress.iterate.com`,
  target: flyTarget,
  headers: { host: `webapp__${projectSlug}.ingress.iterate.com` },
  metadata: { project: projectSlug, service: "webapp" },
  ttlSeconds: 3600,
});

await client.setRoute({
  route: `4096__${projectSlug}.ingress.iterate.com`,
  target: flyTarget,
  headers: { host: `4096__${projectSlug}.ingress.iterate.com` },
  metadata: { project: projectSlug, service: "opencode" },
  ttlSeconds: 3600,
});

// Both hostnames hit the same Fly machine.
// Caddy inside reads the Host header and routes to the right port.
```

## Schema

`routes` table (D1/SQLite):

| Column        | Type        | Description                                                                                |
| ------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `route`       | TEXT PK     | Hostname pattern (e.g. `webapp__proj.ingress.iterate.com` or `*.proj.ingress.iterate.com`) |
| `target`      | TEXT        | Upstream URL                                                                               |
| `headers`     | TEXT (JSON) | Header overrides for upstream request                                                      |
| `metadata`    | TEXT (JSON) | Arbitrary metadata (project slug, service name, etc.)                                      |
| `status`      | TEXT        | `active` / `expired` / `disabled`                                                          |
| `ttl_seconds` | INTEGER     | Optional TTL in seconds                                                                    |
| `expires_at`  | TEXT        | Computed expiration timestamp                                                              |
| `expired_at`  | TEXT        | When the route was marked expired                                                          |
| `created_at`  | TEXT        | Creation timestamp                                                                         |
| `updated_at`  | TEXT        | Last update timestamp                                                                      |

## Caveats

- **No route conflict detection.** Callers are trusted to not create overlapping or conflicting routes. This is fine for now because the only callers are our own control plane and test infrastructure.
- **No multi-tenancy / auth scoping.** A single API token controls all routes. There's no per-project or per-user access control.
- **Lazy TTL expiration only.** Expired routes are marked on next lookup, not proactively cleaned up. Stale rows accumulate until manually deleted.

## Run / deploy

```bash
# Local dev
pnpm --filter @iterate-com/cf-ingress-proxy-worker dev

# Deploy to production
pnpm --filter @iterate-com/cf-ingress-proxy-worker deploy:prd

# Unit tests
pnpm --filter @iterate-com/cf-ingress-proxy-worker test
```
