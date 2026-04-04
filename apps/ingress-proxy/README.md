# Ingress Proxy app

Cloudflare-only: TanStack Start + oRPC + raw D1 route registry, plus public-host proxying.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start + Router + Query
- **Proxy:** requests on stored ingress hosts proxy through to the current upstream target
- **DB:** raw D1 queries via generated TypeSQL helpers (`sql/queries.ts`)
- **Secrets:** Doppler project `ingress-proxy` (see repo `doppler.yaml`). `DOPPLER_CONFIG` is injected by `doppler run`, and `_shared` defines `ALCHEMY_STAGE=${DOPPLER_CONFIG}`. App-local secrets live in root-level `APP_CONFIG.sharedApiSecret` and `APP_CONFIG.typeIdPrefix`. `WORKER_ROUTES` remains a top-level deploy-time env because Alchemy needs it before the worker boots.

## Key files

- `alchemy.run.ts` — Alchemy app + D1 + TanStackStart
- `vite.config.ts` — Alchemy Cloudflare TanStack Start plugin; optional `PORT` for dev
- `src/entry.workerd.ts` — Worker fetch + `withEvlog` + host-based split between dashboard/API traffic and proxy traffic
- `src/context.ts` — `manifest`, `config`, `env`, `db`, `log`
- `src/lib/proxy.ts` — ingress-host normalization plus upstream request/header rewriting
- `src/lib/route-store.ts` — D1-backed route reads/writes and host resolution
- `src/orpc/*` — contract binding + handlers

## Scripts

```bash
doppler run --config stg -- pnpm alchemy:up
doppler run --config prd -- pnpm alchemy:up
doppler run --config stg -- pnpm alchemy:down
doppler run --config prd -- pnpm alchemy:down
```

## Contract

[`apps/ingress-proxy-contract`](../ingress-proxy-contract) — `src/orpc/orpc.ts` implements it.
