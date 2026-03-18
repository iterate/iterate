# Example App

Minimal full-stack app demonstrating a runtime-agnostic app layout:

- **API:** Hono + oRPC over OpenAPI/HTTP with Drizzle ORM
- **Frontend:** TanStack Start (SPA mode) + TanStack Query
- **Runtimes:** Node.js (better-sqlite3) and Cloudflare Workers (D1)
- **WebSockets:** ping-pong demo plus a Node-backed PTY terminal route
- **Observability:** app-local TanStack devtools + evlog request logging

## Why It Is Structured This Way

The main idea is to keep the application logic independent from the runtime that
hosts it.

We do not know for sure yet whether apps like this should ultimately live on
Node, Cloudflare Workers, or something else. Because of that, the example keeps
its routing and websocket behavior in one place and lets each runtime provide
its own concrete wiring.

That keeps things flexible:

- the app logic does not need to choose Node vs Cloudflare up front
- runtime-specific setup stays in the runtime entrypoint
- the same API/router/websocket behavior can be attached to multiple runtimes
- moving between runtimes later is much less invasive

## Layout

### `src/api/app.ts`

This file exports `exampleApp`, which is the runtime-agnostic app definition.

It contains the shared behavior:

- creates the OpenAPI handler
- registers websocket demo routes
- attaches HTTP routes to the provided Hono app

It does **not** decide whether the app is running on Node or Cloudflare.

Instead, it exposes:

```ts
exampleApp.mount({
  app,
  upgradeWebSocket,
  getDeps,
});
```

The runtime provides three things:

- `app`: the concrete Hono app instance to attach routes to
- `upgradeWebSocket`: the runtime-specific Hono websocket helper
- `getDeps`: the runtime-owned dependency bag, such as parsed `env` and `db`

`mount()` mutates the provided Hono app in place and returns nothing.
That keeps the final runtime-specific wiring in the entrypoint.

### `src/node/create-app.ts`

This is the Node runtime composition helper.

It is responsible for Node-specific concerns:

- opening the SQLite database with `better-sqlite3`
- running Drizzle migrations
- creating the Hono app instance
- creating the Node websocket helper with `@hono/node-ws`
- initializing `evlog` once for pretty request logging in local development
- creating the Node-only terminal dependency

### `vite.config.ts`

This is the only local Vite config for the example app.

It is responsible for:

- serving the frontend during `pnpm dev`
- using the embedded Node app plugin so `/api` traffic shares the same Vite port in development
- building the SPA output that `vite preview` serves for the lightweight production-like path

Together these files say: "take `exampleApp`, wire it into a Node runtime for
the API, and let Vite own both the dev server and preview server lifecycle."

### `src/cloudflare/entrypoint.ts`

This is the Cloudflare Worker runtime entrypoint.

It is responsible for Worker-specific concerns:

- opening the D1 database
- creating the Hono app instance
- using `upgradeWebSocket` from `hono/cloudflare-workers`
- initializing the shared `evlog` formatter for Worker console/tail logs
- serving both HTTP and websocket routes through `app.fetch(...)`

This file says: "take the same `exampleApp` and wire it into a Cloudflare
runtime."

## Context Types

There are two different context ideas in play here:

- **initial oRPC context**: the context passed into oRPC handlers up front
- **execution context**: the richer context a procedure sees after middleware adds more fields

This example is careful not to confuse them.

`defineApp` preserves the app definition shape while separating two ideas:

- **runtime deps**: the values returned by `getDeps()`
- **initial oRPC context**: the request-scoped object passed into handlers

By default, `defineApp` turns deps into request context by combining:

```ts
{
  manifest,
  req: { headers, url },
  ...deps,
}
```

This example keeps an explicit `createRequestContext()` in `src/api/app.ts` even
though the default would work, because it makes the projection layer obvious:
the runtime only provides deps, while the app decides what belongs in request
context.

This matters because middleware may add more context later. If auth middleware
eventually injects `user` or `session`, those fields should stay
middleware-derived rather than being added to the runtime contract for
`server.ts` or `worker.ts`.

## Client Transport

The example app exposes a single typed client transport for application RPC:

- `src/client.ts` uses `OpenAPILink`
- `src/frontend/lib/orpc.ts` calls `createExampleClient()`

That means all example-app oRPC clients talk to the HTTP OpenAPI surface under
`/api`. The websocket endpoints are app-specific demos rather than a second
supported transport for the app router.

## Observability

- `src/frontend/routes/__root.tsx`
  - mounts TanStack Router + Query devtools directly under the real app
    providers so the example shows the first-party integration plainly
- `src/frontend/router.tsx`
  - uses cache-level Query / Mutation error hooks for lightweight browser
    debugging without duplicating handlers at every call site
- `packages/shared/src/apps/middleware.ts`
  - emits one evlog wide event per oRPC request, which keeps request logs
    compact and readable in development
- `src/api/routers/test.ts`
  - demonstrates request-scoped logging and server-side exception reporting

## Dev

```bash
pnpm dev          # Vite dev server with embedded Node API on one port
pnpm build        # Build the SPA output
pnpm start        # Preview the built app with Vite
```

## Cloudflare Worker

```bash
pnpm worker:dev     # Local wrangler dev
pnpm worker:deploy  # Deploy to Cloudflare
```

## Env

App-level env parsed in `src/env.ts`:

- `VITE_POSTHOG_PUBLIC_KEY`
  The PostHog public API key used by the frontend client.
- `VITE_POSTHOG_PROXY_URL`
  Proxy endpoint for frontend PostHog traffic. Defaults to
  `/api/integrations/posthog/proxy`.
- `PIRATE_SECRET`
  Required server-side secret exposed by the demo pirate-secret endpoint.

Node-only env:

- `HOST`
- `PORT`
- `EXAMPLE_DB_PATH`

Cloudflare deploy-time env used by `src/cloudflare/alchemy.run.ts`:

- `ALCHEMY_PASSWORD`
- `ALCHEMY_LOCAL`
- `ALCHEMY_STAGE`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `WORKER_ROUTES`

This app now relies on the per-directory Doppler setup declared in `doppler.yaml`:

- project `example`
- path `apps/example/`

Once that scope is configured locally, the package scripts run under
`doppler run -- ...` and pick up the scoped config automatically.

## Database

Drizzle schema in `src/api/db/schema.ts`. Migrations in `drizzle/`.

```bash
pnpm drizzle-kit generate   # Generate migration from schema changes
pnpm drizzle-kit push        # Push schema directly (dev)
```

## CLI

```bash
pnpm dev       # Start the embedded Vite app
pnpm start     # Preview the built Vite app
```
