# cf-proxy-worker

Minimal programmable ingress proxy on Cloudflare Workers.

- Route table in D1 (`route`, `target`, `headers`, `metadata`, `status`, `ttl_seconds`, `expires_at`, `expired_at`)
- Admin API via oRPC (`listRoutes`, `setRoute`, `deleteRoute`)
- Bearer auth for admin API (`CF_PROXY_WORKER_API_TOKEN`)
- Runtime proxy resolves by Host header (exact first, wildcard fallback)
- Matching routes whose TTL has elapsed are lazily marked `expired` and ignored.

## Deploy (prod)

```bash
pnpm --filter @iterate-com/cf-proxy-worker deploy:prd
```

## Local dev

```bash
pnpm --filter @iterate-com/cf-proxy-worker dev
```

## Test

```bash
pnpm --filter @iterate-com/cf-proxy-worker test
```
