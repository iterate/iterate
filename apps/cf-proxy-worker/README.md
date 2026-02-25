# cf-proxy-worker

Programmable ingress proxy for host-based routing on Cloudflare Workers.

## Why this exists

In end-to-end and Playwright tests we need to hit one Fly machine with many different hostnames.

Example test need:

1. Start one Fly machine (single external address), running Caddy + multiple apps behind it.
2. Create several public test hostnames.
3. Route all those hostnames to the same Fly target, but preserve/override `Host` per route.
4. Run tests against those hostnames to validate real host-based app behavior.

This worker is the routing control plane for that.

## What it does

- Stores routes in D1.
- Resolves inbound hostname with exact match first, wildcard fallback.
- Proxies request to `target` URL.
- Rewrites `Host` to target by default, then applies route header overrides.
- Exposes authenticated oRPC admin API:
  - `listRoutes`
  - `setRoute`
  - `deleteRoute`
- Supports route lifecycle fields:
  - `status`
  - `ttl_seconds`
  - `expires_at`
  - `expired_at`
- TTL behavior:
  - if a matching row is expired, resolver marks it `status=expired`, sets `expired_at`, and ignores it.

## Schema

`routes` table columns:

- `route` (PK)
- `target`
- `headers` (json text)
- `metadata` (json text)
- `status` (`active | expired | disabled`)
- `ttl_seconds` (nullable)
- `expires_at` (nullable)
- `expired_at` (nullable)
- `created_at`
- `updated_at`

Indexes:

- `idx_routes_status_expires_at (status, expires_at)`
- `idx_routes_expires_at (expires_at)`
- `idx_routes_status (status)`

## Concrete Fly E2E example

Assume one Fly app target:

- `https://someapp.fly.dev`

You want two hostnames for the same machine:

- `app1__run123.cf-ingress-worker.com`
- `app2__run123.cf-ingress-worker.com`

Configure routes:

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

await client.setRoute({
  route: "app1__run123.cf-ingress-worker.com",
  target: "https://someapp.fly.dev",
  headers: { host: "app1__run123.cf-ingress-worker.com" },
  metadata: { testRun: "run123", app: "app1" },
  ttlSeconds: 3600,
});

await client.setRoute({
  route: "app2__run123.cf-ingress-worker.com",
  target: "https://someapp.fly.dev",
  headers: { host: "app2__run123.cf-ingress-worker.com" },
  metadata: { testRun: "run123", app: "app2" },
  ttlSeconds: 3600,
});
```

Now both test hostnames hit the same Fly machine target, but each request can carry its own host identity for Caddy/internal app routing.

## Auth

Admin API requires:

- `Authorization: Bearer <CF_PROXY_WORKER_API_TOKEN>`

## Run / deploy

Deploy prod:

```bash
pnpm --filter @iterate-com/cf-proxy-worker deploy:prd
```

Local dev:

```bash
pnpm --filter @iterate-com/cf-proxy-worker dev
```

Tests:

```bash
pnpm --filter @iterate-com/cf-proxy-worker test
```

## Future direction

This same ingress pattern can also become a low-cost hosted feature: provide users a public routable URL layer for home-lab/self-hosted services, with lightweight account onboarding (for example email-based signup).
