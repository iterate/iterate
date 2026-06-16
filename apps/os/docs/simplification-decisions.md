# OS simplification: decisions & learnings

Working log for the golden-path refactor of `apps/os` (TanStack Start + oRPC +
Cloudflare Workers, no "apps" framework). Newest entries at the bottom.

## Background

`apps/os` predates the decision to make OS the only product app. It still pays
for generality it no longer needs: an "app manifest", a `BaseAppConfig`
framework with `publicValue`/`redacted` wrappers parsed from `APP_CONFIG_*` env
vars, a hand-rolled `AppContext` threaded around next to (not through) TanStack
Start's own context, and alchemy helpers (`initAlchemy`, `IterateApp`) that
exist to deploy "any iterate app" when there is only one.

## Decisions

### 1. Phantom route fix: `/new-project` instead of `/projects/new` (2026-06-09)

`routes/_app/projects/[_]new.tsx` was an attempt to make `/projects/new` not
collide with the `$projectSlug` matcher. The `[_]` escape hit an upstream
router-generator bug (fixed in TanStack/router#7408, #7453): the route typed as
linkable but never matched — the sidebar linked to a 404. Static segments beat
dynamic ones anyway in TanStack Router ranking, but a project literally named
`new` would then shadow the page. Top-level `/new-project` avoids the whole
class. Jonas explicitly okayed the name.

### 2. routeTree.gen.ts freshness is enforced, not trusted (2026-06-09)

`scripts/generate-route-tree.ts` regenerates the tree with the _same_
`@tanstack/router-generator` version + config the vite build uses (pinned in
devDependencies; keep the pin in lockstep with whatever
`@tanstack/react-start → @tanstack/router-plugin` resolves). `routes:check`
runs inside `typecheck`, so CI fails on a stale tree. Rationale: the route tree
is what makes `<Link to>` typesafe; if it's stale, typecheck "passes" against
fiction.

### 3. TanStack pair upgraded to react-start 1.168.25 / react-router 1.170.15 (2026-06-09)

`react-start` hard-pins its `react-router`; the two must be bumped as a pair or
pnpm splits the install into two router copies. The old pair bundled
router-generator 1.166.17, which predates the escaped-underscore fixes — the
exact bug class we shipped. TanStack now versions packages independently, so
matching minors is no longer the consistency signal; the hard pin inside
react-start is.

### 4. The "apps framework" is gone from OS (2026-06-09)

OS no longer imports anything from `@iterate-com/shared/apps/*`:

- **`src/app.ts` (manifest + AppConfig) → `src/config.ts`.** The manifest
  object existed to parameterize shared helpers by app identity. With OS as
  the only product app, every consumer now states "os" where it means os:
  evlog takes `app: { name, slug }`, the OpenAPI plugin gets a literal title,
  `alchemy.run.ts` passes the slug string to `initAlchemy`.
- **Config utilities moved, not duplicated.** `redacted`/`publicValue`/
  `parseAppConfigFromEnv`/`extractPublicConfigSchema` are generic and used by
  semaphore too, so they live in `@iterate-com/shared/config` (and evlog in
  `@iterate-com/shared/evlog`). The old app-framework config shims are gone.
- **`AppContext` → `RequestContext`** (`src/request-context.ts`), which _is_
  the TanStack Start request context (the `Register` augmentation lives next
  to the type). It now carries request-scoped state only: config, db, log,
  auth principal/session, waitUntil, `ctx.exports`, project scope.
- **Worker bindings are read from `import { env } from "cloudflare:workers"`**
  at the point of use instead of being threaded through context as optional
  fields. This deleted a dozen `if (!context.X) throw "binding not available"`
  guards for bindings that are always bound in reality. `ctx.exports` is the
  one exception kept on the context — Cloudflare exposes it only on
  ExecutionContext/DurableObjectState, not as a module import.
- **`entry.workerd.ts` → `worker.ts`**, rewritten as a linear dispatcher
  (~190 lines): infra routes → evlog wrapper → project ingress → stream
  RPC/capnweb → TanStack Start handler. The debug endpoints moved to
  `src/debug-routes.ts`, project-stream RPC to
  `src/domains/streams/project-stream-rpc.ts`, ingress rule lookup to
  `src/ingress/lookup.ts`. `IterateApp` got a `main` option (default
  unchanged for semaphore).
- **Historical note:** this phase briefly kept an inline `__internal` oRPC
  namespace for CLI discovery and browser public-config bootstrap. That surface
  has since been removed from OS; current operator work uses `pnpm cli itx ...`
  and `/api/itx`.
- **Deliberate exception:** `scripts/cli.ts` keeps using the shared CLI
  harness (`@iterate-com/shared/apps/cli`) — it is cross-app tooling, not
  runtime code, and inlining it would be bloat, not simplification.
- Dropped `externalEgressProxy` from the config schema: nothing in OS consumed
  it and no Doppler config sets it (checked prd).

### 5. Surviving the routeTree.gen.ts Register footer (2026-06-10)

The upgraded Start vite plugin appends a `declare module '@tanstack/react-start'`
block to routeTree.gen.ts registering `ssr`, `router: Awaited<ReturnType<typeof getRouter>>`,
and `config: Awaited<ReturnType<typeof startInstance.getOptions>>`. That one block forced several
structural changes, all verified by bisection:

- `scripts/generate-route-tree.ts` mirrors the footer via `routeTreeFileFooter`
  so `routes:check` stays byte-identical with what `vite build` writes.
- `Register.router → getRouter → routeTree → routes` must never close back
  into Register. Three rules now keep it acyclic:
  1. `getRouter` has no explicit return annotation, and components passed to
     `createRouter` options are wrapped in lambdas
     (`defaultNotFoundComponent: () => <DefaultNotFoundComponent />`) — direct
     component references force a props-compatibility check that traverses the
     registered router types (this was the actual poison edge, found by
     rebuilding router.tsx from the start-basic-react-query reference and
     re-adding one option at a time).
  2. Route files must not import from `router.tsx` — `RouterContext` lives in
     `src/router-context.ts`.
  3. Server functions used by route files live outside `routes/`
     (`src/lib/root-auth-snapshot.ts`, `src/lib/sidebar-state.ts`) with
     explicit type annotations.
- The request context is registered on **both** `@tanstack/react-start` and
  `@tanstack/react-router`: in the installed versions `handler.fetch` types its
  context from react-router's Register while middleware/getGlobalStartContext
  read react-start's. These are distinct interfaces.
- `iterateAuthMiddleware` is now `createMiddleware({ type: "request" })` — it
  is registered as requestMiddleware and returns raw Responses, which is the
  request-middleware contract.
- Upstream type bug worked around: once the footer registers `config`,
  `getGlobalStartContext()`'s return type collapses to `undefined`
  (`AssignAllMiddleware<[]>` degenerates to `never` inside
  `AssignAllServerRequestContext`). `getRequestContext()` /
  `requireRequestContext()` in `src/request-context.ts` are the typed accessors
  that state the runtime truth; nothing else should call
  `getGlobalStartContext` directly.

### 6. Security: closed an unauthenticated secret leak in `__internal/debug` (2026-06-10)

While reviewing the refactor we found that `GET /api/__internal/debug` —
**unauthenticated** — returned `process.env`, and under `nodejs_compat` (which
all our workers enable) `process.env` contains the raw `APP_CONFIG` secret blob
(Cloudflare API token, OAuth client secrets, OpenAI/xAI/Gemini keys, admin API
secret). Confirmed live on both `os.iterate.com` and `semaphore.iterate.com`
before this PR. Rotate those secrets.

The leak was in the old shared app internal router helper. OS's inline
`__internal` router already returns a static `{ runtime: "workerd" }`, and
semaphore now implements the same static debug response in its local router.

### 7. Preview smoke test: real agent conversation end to end (2026-06-10)

Verified the deployed PR preview (`os.iterate-preview-3.com`) with a fully
headless browser, no human in the loop (procedure: `preview-agent-browser-smoke.md`):

- Signed in as the bootstrap admin, created a project via **`/new-project`**
  (the renamed route — the original bug), and drove an agent conversation
  through the browser UI: typed a question into the agent's message box, and the
  agent (DO + OpenAI) replied correctly. Confirmed both via the UI send and via
  `agents runtime-state`. The security fix is live (`/api/__internal/debug`
  returns `{ runtime: "workerd" }`).

Two findings worth keeping:

- **Transient `Project <id> not found` on project pages = expired OS session
  JWT, not a bug.** The OS session access token is short-lived; once it lapses,
  project-scoped page queries surface a NOT_FOUND in the error boundary. A fresh
  sign-in fixes it, and the same procedures succeed over direct RPC with a fresh
  cookie throughout. Cost me a long debugging detour — documented so the next
  person doesn't repeat it.
- **Live stream display needs WebSocket.** The current browser live path is
  `/api/itx`; if preview live rendering fails while agent turns still complete
  server-side, debug the itx WebSocket path and stream subscription state.

- **`Preview / deploy` red was `apps/semaphore`, not `apps/os` — a dropped
  `baseUrl` in the migrated config.** On PR #1411 the deploy job failed at
  `scripts/preview/router.ts:113` after a ~9-minute silent gap (the readiness
  poll's 10-min budget, `preview.ts:43`). The misleading part: `os`'s readiness
  passed (`status: awaiting-tests`); the recorded state showed **semaphore**
  `deploy-failed` with `Readiness check returned 522 for
https://semaphore.iterate-preview-2.com/api/__internal/health`. The semaphore
  worker was healthy on its `*.workers.dev` URL (200) but the custom hostname
  answered 522. Root cause: this PR rewrote `apps/semaphore/src/config.ts` as a
  fresh `z.object({...})` instead of `BaseAppConfig.extend({...})`, dropping the
  inherited `baseUrl` field. `IterateApp` derives the worker route + proxied DNS
  from `runtimeConfig.baseUrl` (`deriveWorkerRouteHosts`,
  `packages/shared/src/alchemy/iterate-app.ts`); with `baseUrl` undefined it
  created no route, so the leftover hostname resolved via DNS but had no worker
  bound → Cloudflare 522. Fix: add `baseUrl: publicValue(z.url().optional())`
  back to the schema (the Doppler config already supplies `APP_CONFIG_BASE_URL`).
  Lessons: (1) when a deploy "hangs" then fails, read the recorded preview state
  for the _per-app_ status and message — the failing app may not be the one you
  changed most; (2) a 522 on a custom hostname that's 200 on `workers.dev` is a
  missing/unbound worker route, not a worker bug; (3) replacing a
  `BaseAppConfig.extend(...)` with a hand-written object silently drops the base
  fields the platform depends on — prefer extending the base.

## Learnings

- An unauthenticated debug endpoint that echoes `process.env` is a secret leak
  the moment `nodejs_compat`/`nodejs_compat_populate_process_env` is on — which
  is always, for us. Debug routes must be auth-gated AND must never serialize
  env.
- TanStack route files whose names need escaping are a smell: if you reach for
  `[_]` you are fighting route ranking that already does what you want
  (static beats dynamic).
- `@tanstack/eslint-plugin-router` ships exactly one rule
  (`create-route-property-order`) — already enabled in `.oxlintrc.json`. Link
  validity comes from generated types, not lint, so tree freshness is the thing
  to enforce.
