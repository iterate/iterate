# Events app

Cloudflare-only: TanStack Start + oRPC + Drizzle on D1, Alchemy + Vite.

## Stack

- **API:** oRPC at `/api`; optional WebSocket oRPC at `/api/orpc-ws`
- **Frontend:** TanStack Start + Router + Query
- **DB:** Drizzle + D1 (`src/entry.workerd.ts`). The **Secrets** UI stores values in D1 **as plaintext** (demo only — not a production secret manager).
- **Secrets:** Doppler project `events` (see repo `doppler.yaml`). `DOPPLER_CONFIG` is injected by `doppler run`, and `_shared` defines `ALCHEMY_STAGE=${DOPPLER_CONFIG}`. Local uses personal dev configs like `dev_jonas`; PR previews use numbered `preview_N` configs with routed hosts like `events-preview-N.iterate.com`; production uses `prd`. Non-local Alchemy state is stored in Cloudflare, so Doppler also needs `ALCHEMY_STATE_TOKEN`.

## Key files

- `alchemy.run.ts` — Alchemy app + D1 + TanStackStart
- `vite.config.ts` — Alchemy Cloudflare TanStack Start plugin + PostHog; optional `PORT` for dev
- `src/entry.workerd.ts` — Worker fetch + `withEvlog` + oRPC WS upgrade via `crossws`
- `src/context.ts` — `manifest`, `config`, `db`, `log`
- `src/orpc/*` — contract binding + handlers

## Scripts

```bash
pnpm dev           # doppler + Alchemy local (Vite); optional PORT= for fixed port; Ctrl+C to stop
pnpm build         # production client/server bundle
pnpm deploy        # `doppler run --config prd` + run `alchemy.run.ts` for stage `prd`
pnpm alchemy:up    # run `alchemy.run.ts`; caller supplies env
pnpm alchemy:down  # run `alchemy.run.ts --destroy`; caller supplies env
```

## Contract

[`apps/events-contract`](../events-contract) — `src/orpc/orpc.ts` implements it.
