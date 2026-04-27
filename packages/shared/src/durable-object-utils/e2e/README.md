# Durable Object Utils E2E Harness

The e2e tests target the HTTP fronting worker in `../test-harness/initialize-fronting-worker.ts`.

Run against local Miniflare/Wrangler dev:

```bash
# Terminal 1
pnpm --dir packages/shared exec wrangler dev --config ./src/durable-object-utils/e2e/wrangler.e2e.jsonc --port 8787

# Terminal 2
DURABLE_OBJECT_UTILS_E2E_BASE_URL=http://127.0.0.1:8787 pnpm --dir packages/shared test:durable-object-utils:e2e
```

Deploy an ephemeral worker with Alchemy:

```bash
cd packages/shared
doppler run --config <config> -- pnpm test:durable-object-utils:e2e:deploy
```

The deployment script expects Cloudflare and Alchemy environment variables to
already be present. Use any Doppler config that provides those values, for
example `dev_jonas`, `dev`, or a CI/test config in the `_shared` project. The
script deploys an ephemeral Alchemy stage, runs Vitest against the Worker URL,
and then destroys the stage. Cleanup failure fails the command so orphaned
resources are visible instead of silently ignored.

This harness is intentionally separate from the default package tests. The
normal CI path runs the local type/unit/worker-pool checks through
`pnpm test:durable-object-utils`; the Alchemy path is for production-runtime
coverage because it provisions real Cloudflare Worker, Durable Object, SQLite,
and D1 resources.
