# Example App

Minimal full-stack app demonstrating a runtime-agnostic app layout:

- **API:** Hono + oRPC (HTTP + WebSocket) with Drizzle ORM
- **Frontend:** TanStack Start (SPA mode) + TanStack Query
- **Runtimes:** Node.js (better-sqlite3) and Cloudflare Workers (D1)
- **WebSockets:** ping-pong (1s delay echo) + confetti broadcast

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

- creates the oRPC handler
- creates the OpenAPI handler
- defines websocket route resolution
- attaches HTTP routes to the provided Hono app

It does **not** decide whether the app is running on Node or Cloudflare.

Instead, it exposes:

```ts
exampleApp.attachRuntime({
  honoApp,
  crosswsAdapter,
  createRuntimeOrpcContext,
});
```

The runtime provides three things:

- `honoApp`: the concrete Hono app instance to attach routes to
- `crosswsAdapter`: the runtime-specific CrossWS adapter factory
- `createRuntimeOrpcContext`: only the runtime-owned part of the initial oRPC context

The returned value is:

```ts
{
  (honoApp, crossws);
}
```

That means the runtime entrypoint still owns the final server-specific wiring.

### `src/node/server.ts`

This is the Node runtime entrypoint.

It is responsible for Node-specific concerns:

- opening the SQLite database with `better-sqlite3`
- running Drizzle migrations
- creating the Hono app instance
- using the Node CrossWS adapter
- attaching websocket upgrades to the Node server

In other words, this file says: "take `exampleApp` and wire it into a Node
runtime."

### `src/cloudflare/worker.ts`

This is the Cloudflare Worker runtime entrypoint.

It is responsible for Worker-specific concerns:

- opening the D1 database
- creating the Hono app instance
- using the Cloudflare CrossWS adapter
- handling websocket upgrades using the Worker runtime APIs

This file says: "take the same `exampleApp` and wire it into a Cloudflare
runtime."

## Context Types

There are two different context ideas in play here:

- **initial oRPC context**: the context passed into oRPC handlers up front
- **execution context**: the richer context a procedure sees after middleware adds more fields

This example is careful not to confuse them.

`defineApp` only preserves the app definition shape and types. The actual
assembly of the initial oRPC context happens in `src/api/app.ts`, because that
file is the place that has:

- the app's own `appManifest`
- the live `Request`
- the runtime-owned values returned by `createRuntimeOrpcContext()`, including
  parsed `env`

Runtimes do **not** pass either of those in manually. Instead they provide
`createRuntimeOrpcContext`, and `src/api/app.ts` assembles the full initial
context by merging:

```ts
{
  manifest: appManifest,
  req,
  ...createRuntimeOrpcContext(),
}
```

That means runtime files only provide values they truly own, like parsed `env`
and `db`.

This matters because middleware may add more context later. If auth middleware
eventually injects `user` or `session`, those fields should stay
middleware-derived rather than being added to the runtime contract for
`server.ts` or `worker.ts`.

## Dev

```bash
pnpm dev          # Vite frontend + Node API backend
pnpm build        # Production build
pnpm preview      # Preview production build locally
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
- `CONFETTI_DELAY_MS`
  Delay before confetti fires on the websocket demo. Defaults to `1300`.
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
pnpm cli dev       # Start dev servers
pnpm cli preview   # Start preview servers
```
