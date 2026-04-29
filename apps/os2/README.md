# OS App

Minimal full-stack app: TanStack Start + oRPC over OpenAPI/HTTP + sqlfu, running on Cloudflare Workers.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start in SPA mode + TanStack Router + TanStack Query
- **Auth:** Clerk sessions for the app, Clerk OAuth Applications for remote MCP clients
- **DB:** sqlfu + Cloudflare D1. SQL definitions, migrations, and typed query wrappers live under `src/db`.
- **Observability:** Workers use the shared `withEvlog()` runtime wrapper; shared `useEvlog()` only enriches a request-scoped log
- **Runtime config:** optional `APP_CONFIG` JSON env var plus `APP_CONFIG_*` nested overrides, with frontend-visible fields annotated in the schema and exposed through the typed `__internal.publicConfig` oRPC procedure

## Key files

- `src/app.ts` — app manifest plus app config schema
- `src/entry.workerd.ts` — Cloudflare Workers runtime entry: D1, request context, websocket upgrade handling
- `src/orpc/orpc.ts` — oRPC composition point plus `activeOrganizationMiddleware`
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

The OS2 app has no public product pages. Browser users without a Clerk session
are sent to `/sign-in`; signed-in users without an active Clerk Organization are
sent to `/organization` to create or select one. The app shell uses Clerk's
`OrganizationSwitcher` with `hidePersonal` and `UserButton` in the sidebar.

The browser talks to `/api` over OpenAPI/HTTP. SSR uses `createRouterClient`
for in-process calls with the same typed router. Runtime app context
(`manifest`, `config`, `db`, `log`, `auth`) is attached in `entry.workerd.ts`
and the API routes, and oRPC initial context is built from that runtime context
plus `rawRequest`. Runtime auth checks are implemented as oRPC middleware:
`activeOrganizationMiddleware` rejects unauthenticated or personal-account
requests and injects `context.activeOrganization` for handlers.

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

The current domain table is `projects`: `id`, `slug`, `clerk_org_id`,
`created_by_clerk_user_id`, `custom_hostname`, `metadata`, `created_at`, and
`updated_at`. A project belongs to exactly one Clerk Organization. Project IDs
are generated in TypeScript with the shared TypeID helper using local prefix
`proj` and app config `typeIdPrefix`.

`created_at` defaults in SQL. `updated_at` is set by the app's update queries
instead of a SQLite trigger because the Cloudflare D1 migration API rejected the
trigger migration with `SQL_INPUT_ERROR`/`incomplete input`, while Alchemy also
needs to apply the same plain migration files during deploy.

`alchemy.run.ts` points the Cloudflare D1 binding at `./src/db/migrations`, so
`pnpm cf:dev` and `pnpm cf:deploy` apply the same SQL migrations that sqlfu
tracks. `sqlfu.config.ts` uses sqlfu's D1 migration preset against Alchemy's
local Miniflare D1, so `pnpm sqlfu:check` and `pnpm sqlfu:migrate` use the same
D1 migration table shape as Alchemy/Wrangler once `.alchemy/local/wrangler.jsonc`
has been materialized.

## Clerk Auth

First-party references:

- Clerk TanStack Start middleware:
  https://clerk.com/docs/reference/tanstack-react-start/clerk-middleware
- Clerk TanStack Start provider:
  https://clerk.com/docs/tanstack-react-start/components/clerk-provider
- Clerk Organization switcher:
  https://clerk.com/docs/tanstack-react-start/reference/components/organization/organization-switcher
- Clerk Organizations:
  https://clerk.com/docs/organizations/overview
- Clerk OAuth / MCP guide:
  https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server
- Clerk OAuth implementation:
  https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth
- Cloudflare `McpAgent` auth props:
  https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/
- oRPC context and middleware:
  https://orpc.dev/docs/context and https://orpc.dev/docs/middleware

Required Clerk dashboard setup:

1. Enable Organizations for the Clerk application used by OS2.
2. Configure the app to require organization context for OS2 usage. OS2 also
   hides Clerk Personal Account mode in the sidebar with `hidePersonal`.
3. Copy the Clerk publishable key, secret key, and JWT public key into OS2
   runtime config.
4. Create a Clerk OAuth Application for OS2 MCP clients. Keep token format as
   JWT, enable public/PKCE clients, and enable Dynamic Client Registration for
   MCP clients that self-register.
5. The MCP OAuth application only needs Clerk-supported data scopes such as
   `email` and `profile`; OS2 authorization remains org/project scoped in app
   code.

`/mcp` is a protected OAuth resource. OS2 publishes RFC 9728 metadata at
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`, pointing clients at Clerk as the
authorization server. The Worker verifies Clerk-issued bearer tokens
networklessly with `CLERK_JWT_KEY` before passing identity props to the
`IterateMcpServer` Durable Object.

## Middleware Notes

`src/start.ts` installs Clerk's TanStack Start request middleware. Request
logging is owned by the shared `withEvlog()` wrapper in the Worker runtime
entrypoint.

## Codemode

Execute JavaScript in isolated dynamic worker sandboxes via oRPC or MCP.

- **UI:** `/codemode` — code editor with streaming event log
- **oRPC:** `codemode.execute` (streaming eventIterator) and `codemode.describe`
- **MCP:** `run_code` tool on the MCP server at `/mcp`

### Using the MCP server with Claude CLI

After the Clerk OAuth Application is configured with Dynamic Client
Registration, add the OS2 remote MCP endpoint to the project:

```bash
claude mcp add --transport http os2 https://os.iterate-dev-jonas.com/mcp --scope project
```

Then in any conversation: "Use run_code to compute the first 10 fibonacci
numbers". The client should discover OS2's protected-resource metadata and run
the Clerk OAuth flow.

### Testing oRPC with curl

```bash
# Execute code (returns SSE event stream)
curl 'https://os.iterate-dev-jonas.com/api/codemode/execute' \
  -X POST -H 'content-type: application/json' \
  -d '{"code":"async () => 1 + 1","providers":[]}'
```

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

- `APP_CONFIG_BASE_URL=https://os.iterate2.com` -> `baseUrl`
- `APP_CONFIG_CLERK__PUBLISHABLE_KEY=pk_test_...` -> `clerk.publishableKey`
- `APP_CONFIG_CLERK__SECRET_KEY=sk_test_...` -> `clerk.secretKey`
- `APP_CONFIG_CLERK__JWT_KEY='-----BEGIN PUBLIC KEY-----...'` -> `clerk.jwtKey`
- `APP_CONFIG_CLERK__OAUTH_CLIENT_ID=...` -> `clerk.oauthClientId`
- `APP_CONFIG_CLERK__OAUTH_CLIENT_SECRET=...` -> `clerk.oauthClientSecret`
- `APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate2.app"]` -> `projectHostnameBases`
- `APP_CONFIG_TYPE_ID_PREFIX=os` -> `typeIdPrefix`
- `APP_CONFIG_LOGS__STDOUT_FORMAT=pretty` -> `logs.stdoutFormat`

The root route loads the typed `__internal.publicConfig` procedure over `/api`
during SSR. The app keeps the built-in PostHog proxy route from the source
template, but it does not enable PostHog by default.

OS:

```json
{
  "clerk": {
    "publishableKey": "pk_test_...",
    "secretKey": "sk_test_...",
    "jwtKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "oauthClientId": "...",
    "oauthClientSecret": "..."
  },
  "typeIdPrefix": "os",
  "logs": {
    "stdoutFormat": "raw"
  }
}
```

OS override:

```bash
APP_CONFIG_BASE_URL=https://os.iterate-dev-jonas.com \
APP_CONFIG_PROJECT_HOSTNAME_BASES='["iterate-dev-jonas.app"]'
```
