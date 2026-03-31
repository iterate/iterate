# Events app

Cloudflare-only: TanStack Start + oRPC + Drizzle on D1, Alchemy + Vite.

## Stack

- **API:** oRPC at `/api`; optional WebSocket oRPC at `/api/orpc-ws`
- **Frontend:** TanStack Start + Router + Query
- **DB:** Drizzle + D1 (`src/entry.workerd.ts`). The **Secrets** UI stores values in D1 **as plaintext** (demo only — not a production secret manager).
- **Secrets:** Doppler project `events` (see repo `doppler.yaml`). `DOPPLER_CONFIG` is injected by `doppler run`, and `_shared` defines `ALCHEMY_STAGE=${DOPPLER_CONFIG}`. Today we use `dev`, personal dev configs like `dev_jonas`, and `prd` only. Local: `doppler setup --project events --config dev_jonas` (or `dev_misha` / `dev_rahul`). Deploy uses `--config prd`.

## Key files

- `alchemy.run.ts` — Alchemy app + D1 + TanStackStart
- `vite.config.ts` — Alchemy Cloudflare TanStack Start plugin + PostHog; optional `PORT` for dev
- `src/entry.workerd.ts` — Worker fetch + `withEvlog` + oRPC WS upgrade via `crossws`
- `src/context.ts` — `manifest`, `config`, `db`, `log`
- `src/orpc/*` — contract binding + handlers

## Scripts

```bash
pnpm dev     # doppler + Alchemy local (Vite); optional PORT= for fixed port; Ctrl+C to stop
pnpm build   # production client/server bundle
pnpm deploy  # `doppler run --config prd` — `_shared` resolves `ALCHEMY_STAGE=prd`, `ALCHEMY_LOCAL=false`, etc.
```

## Contract

[`apps/events-contract`](../events-contract) — `src/orpc/orpc.ts` implements it.
