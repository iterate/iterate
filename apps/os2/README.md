# OS App

Minimal full-stack app: TanStack Start + oRPC over OpenAPI/HTTP + sqlfu, running on Cloudflare Workers.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start in SPA mode + TanStack Router + TanStack Query
- **DB:** sqlfu + Cloudflare D1. SQL definitions, migrations, and typed query wrappers live under `src/db`.
- **Observability:** Workers use the shared `withEvlog()` runtime wrapper; shared `useEvlog()` only enriches a request-scoped log
- **Runtime config:** optional `APP_CONFIG` JSON env var plus `APP_CONFIG_*` nested overrides, with frontend-visible fields annotated in the schema and exposed through the typed `__internal.publicConfig` oRPC procedure

## Key files

- `src/app.ts` — app manifest plus app config schema
- `src/entry.workerd.ts` — Cloudflare Workers runtime entry: D1, request context, websocket upgrade handling
- `src/orpc/orpc.ts` — oRPC composition point: `implement(contract).$context<T>().use(useEvlog())`
- `src/orpc/root.ts` — concrete procedure handlers (composed from `orpc/routers/*`)
- `src/orpc/client.ts` — isomorphic oRPC client plus TanStack Query client factory/query utils
- `src/db/definitions.sql` — sqlfu schema source of truth
- `src/db/migrations` — SQL migrations consumed by Alchemy for D1
- `src/db/queries` — checked-in SQL queries plus generated typed wrappers
- `src/context.ts` — Start request context + oRPC context types
- `src/router.tsx` — TanStack Router setup plus SSR Query integration
- `src/routes/api.$.ts` — OpenAPI oRPC catch-all route mounted at `/api`
- `src/routes/__root.tsx` — root route with sidebar shell, SSR-loaded public config, shared app providers, and devtools
- `vite.config.ts` — Cloudflare dev/build (uses Alchemy plugin)
- PostHog source maps are not configured for this minimal app.
- `runtime-smoke.test.ts` — sqlfu asset check plus optional Cloudflare runtime smoke checks

## Runtime architecture

The browser talks to `/api` over OpenAPI/HTTP. SSR uses `createRouterClient`
for in-process calls with the same typed router. Runtime app context
(`manifest`, `config`, `db`, `log`) is attached in `entry.workerd.ts`, and
oRPC initial context is built from that runtime context plus `rawRequest`.

Cloudflare Workers wrap requests with the shared `withEvlog()` helper. The
runtime entrypoint still assembles app-specific deps, but request logger
creation, ALS scoping, pretty/raw formatting, filtering, and request-final flush
now live in one shared place. The shared `useEvlog()` oRPC middleware still does
not create or emit logs; it only adds app/RPC context to the log it receives.

Known caveat: the current shared wrapper still flushes in `finally`, so
long-lived streamed responses such as SSE can have later request-scoped
`log.info()` calls omitted from the final emitted request event. Stream-close
aware finalization is a follow-up improvement.

`config.logs` is consumed by the shared runtime logging wrapper:

- `stdoutFormat` chooses between shared pretty stdout rendering and shared raw
  structured output
- `filtering.rules` lets an app override default request-log filters
- successful `/posthog-proxy/**` requests are suppressed by default unless the
  app config opts back into logging them

Each request-final evlog event still adds a short summary `message` while
keeping the structured wide event fields as the source of truth.

## Contract

`apps/os2-contract` owns the typed RPC surface. `src/orpc/orpc.ts` binds implementation to contract.

## Database

sqlfu is the database source of truth:

- `src/db/definitions.sql` declares the desired schema
- `src/db/migrations/*.sql` is the migration history
- `src/db/queries/*.sql` contains checked-in application queries
- `src/db/queries/.generated` and `src/db/migrations/.generated` are regenerated with `pnpm sqlfu:generate`

`alchemy.run.ts` points the Cloudflare D1 binding at `./src/db/migrations`, so
`pnpm cf:dev` and `pnpm cf:deploy` apply the same SQL migrations that sqlfu
tracks. `sqlfu.config.ts` uses sqlfu's D1 migration preset against Alchemy's
local Miniflare D1, so `pnpm sqlfu:check` and `pnpm sqlfu:migrate` use the same
D1 migration table shape as Alchemy/Wrangler once `.alchemy/local/wrangler.jsonc`
has been materialized.

## Middleware Notes

This app does not currently use `src/start.ts`. Request logging is now owned by
the shared `withEvlog()` wrapper in the Worker runtime entrypoint.

## Dev

```bash
doppler run --config dev -- pnpm alchemy:up    # dev deploy
doppler run --config prd -- pnpm alchemy:up    # production-style deploy
doppler run --config dev -- pnpm alchemy:down  # destroy the dev stack
pnpm dev            # Cloudflare local dev
pnpm cf:deploy      # Deploy to Cloudflare
pnpm sqlfu:generate # Regenerate typed SQL wrappers and bundled migrations
pnpm sqlfu:check    # Check migration history against definitions.sql
pnpm sqlfu:ui       # Start the sqlfu UI bridge, then open https://sqlfu.dev/ui
```

## Runtime config

Runtime config is assembled from:

- optional base JSON in `APP_CONFIG`
- zero or more nested overrides in `APP_CONFIG_*`

The final merged object must satisfy the app schema. If `APP_CONFIG` is
missing, schema defaults and env overrides can still produce a valid config.

Overrides use `__` as the nesting separator and convert env-style keys to the
schema's camelCase shape. For OS:

- `APP_CONFIG_PIRATE_SECRET=arrr` -> `pirateSecret`
- `APP_CONFIG_LOGS__STDOUT_FORMAT=pretty` -> `logs.stdoutFormat`

The root route loads the typed `__internal.publicConfig` procedure over `/api`
during SSR. The app keeps the built-in PostHog proxy route from the source
template, but it does not enable PostHog by default.

OS:

```json
{
  "logs": {
    "stdoutFormat": "raw"
  }
}
```

OS override:

```bash
APP_CONFIG='{"pirateSecret":"base-secret"}' \
APP_CONFIG_PIRATE_SECRET=override-secret
```
