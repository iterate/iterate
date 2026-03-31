# Example App

Minimal full-stack app: TanStack Start + oRPC over OpenAPI/HTTP + Drizzle, dual-runtime (Node + Cloudflare Workers).

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Terminal:** PTY websocket at `/api/pty`
- **Frontend:** TanStack Start in SPA mode + TanStack Router + TanStack Query
- **DB:** Drizzle ORM — better-sqlite3 (Node), D1 (Workers). Shared `BaseSQLiteDatabase<"sync" | "async">` type.
- **Observability:** Node and Workers both use the shared `withEvlog()` runtime wrapper; shared `useEvlog()` only enriches a request-scoped log
- **Runtime config:** optional `APP_CONFIG` JSON env var plus `APP_CONFIG_*` nested overrides, with frontend-visible fields annotated in the schema and exposed through the typed `common.publicConfig` oRPC procedure

## Key files

- `src/app.ts` — app manifest plus app config schema
- `src/entry.node.ts` — Node runtime entry: SQLite, migrations, request context
- `src/entry.workerd.ts` — Cloudflare Workers runtime entry: D1, request context, websocket upgrade handling
- `src/orpc/orpc.ts` — oRPC composition point: `implement(contract).$context<T>().use(useEvlog())`
- `src/orpc/root.ts` — concrete procedure handlers (composed from `orpc/routers/*`)
- `src/orpc/client.ts` — isomorphic oRPC client plus TanStack Query client factory/query utils
- `src/db/schema.ts` — Drizzle schema
- `src/context.ts` — Start request context + oRPC context types
- `src/router.tsx` — TanStack Router setup plus SSR Query integration
- `src/routes/api.$.ts` — OpenAPI oRPC catch-all route mounted at `/api`
- `src/routes/api.pty.ts` — PTY websocket route
- `src/routes/__root.tsx` — root route with sidebar shell, SSR-loaded public config, shared app providers, and devtools
- `vite.config.ts` — Node dev/build via Nitro
- `vite.cf.config.ts` — Cloudflare dev/build (uses Alchemy plugin)
- PostHog source maps: `vite.config.ts` / `vite.cf.config.ts` pass `apiKey`, `projectId`, `releaseName: manifest.slug`, and `releaseVersion: "latest"` into `posthogSourcemaps` from `@iterate-com/shared/posthog/vite-plugin` (Doppler example `dev` / `stg` / `prd`, not `APP_CONFIG`)
- `runtime-smoke.test.ts` — smoke matrix for dev, preview, start, and Cloudflare runtimes

## Runtime architecture

The browser talks to `/api` over OpenAPI/HTTP. SSR uses `createRouterClient`
for in-process calls with the same typed router. Runtime app context
(`manifest`, `config`, `db`, `pty`, `log`) is attached in `entry.node.ts` /
`entry.workerd.ts`, and oRPC initial context is built from that runtime context
plus `rawRequest`.

Node and Cloudflare Workers both wrap requests with the shared
`withEvlog()` helper. The runtime entrypoint still assembles app-specific deps,
but request logger creation, ALS scoping, pretty/raw formatting, filtering, and
request-final flush now live in one shared place. The shared `useEvlog()` oRPC
middleware still does not create or emit logs; it only adds app/RPC context to
the log it receives.

Known caveat: the current shared wrapper still flushes in `finally`, so
long-lived streamed responses such as SSE can have later request-scoped
`log.info()` calls omitted from the final emitted request event. Stream-close
aware finalization is a follow-up improvement.

`config.logs` is consumed by the shared runtime logging wrapper:

- `stdoutFormat` chooses between shared pretty stdout rendering and shared raw
  structured event output
- `filtering.rules` lets an app override default request-log filters
- successful `/posthog-proxy/**` requests are suppressed by default unless the
  app config opts back into logging them

Each request-final evlog event still adds a short one-line summary `message`
while keeping the structured wide event fields, including `requestLogs`, as
the source of truth.

## Contract

`apps/example-contract` owns the typed RPC surface. `src/orpc/orpc.ts` binds implementation to contract.

## Middleware Notes

This app does not currently use `src/start.ts`. Request logging is now owned by
the shared `withEvlog()` wrapper in the runtime entrypoints rather than Nitro's
`evlog/nitro/v3` integration.

## Dev

```bash
pnpm dev          # Node dev server
pnpm start        # Run the built server bundle and restart on rebuilds
pnpm cf:dev       # Cloudflare local dev
pnpm cf:deploy    # Deploy to Cloudflare
```

Pin the port with `PORT` or `NITRO_PORT` (default **3000** when unset). The Node bundle uses **srvx**; it prints `➜ Listening on: …` unless `TEST` is set (then the banner is hidden). The `start` script unsets `TEST` so Doppler does not suppress it. Request **evlog** lines match `pnpm dev` once you send traffic.

## Runtime config

Runtime config is assembled from:

- optional base JSON in `APP_CONFIG`
- zero or more nested overrides in `APP_CONFIG_*`

The final merged object must satisfy the app schema. If `APP_CONFIG` is
missing, schema defaults and env overrides can still produce a valid config.

Overrides use `__` as the nesting separator and convert env-style keys to the
schema's camelCase shape. For example:

- `APP_CONFIG_POSTHOG__API_KEY=phc_xxx` -> `posthog.apiKey`
- `APP_CONFIG_PIRATE_SECRET=arrr` -> `pirateSecret`
- `APP_CONFIG_LOGS__STDOUT_FORMAT=pretty` -> `logs.stdoutFormat`

The root route loads the typed `common.publicConfig` procedure over `/api`
during SSR, and PostHog is configured from `posthog.apiKey` on the
client. The app always uses the built-in PostHog proxy at `/posthog-proxy`
and always enables bootstrap-from-url behavior.

Example:

```json
{
  "logs": {
    "stdoutFormat": "raw"
  },
  "posthog": {
    "apiKey": "phc_xxx"
  }
}
```

Example override:

```bash
APP_CONFIG='{"pirateSecret":"base-secret","posthog":{"apiKey":"phc_base"}}' \
APP_CONFIG_POSTHOG__API_KEY=phc_override \
APP_CONFIG_PIRATE_SECRET=override-secret
```
