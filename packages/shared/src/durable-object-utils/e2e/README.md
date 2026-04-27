# Durable Object Utils E2E Harness

The e2e tests target the HTTP fronting worker in `../test-harness/initialize-fronting-worker.ts`.

Run against local Miniflare/Wrangler dev:

```bash
pnpm --dir packages/shared exec wrangler dev --config ./src/durable-object-utils/e2e/wrangler.e2e.jsonc --port 8787
DURABLE_OBJECT_UTILS_E2E_BASE_URL=http://127.0.0.1:8787 pnpm --dir packages/shared test:durable-object-utils:e2e
```

Deploy an ephemeral worker with Alchemy:

```bash
doppler run --config <config> -- pnpm --dir packages/shared test:durable-object-utils:e2e:deploy
```

The deployment script expects Cloudflare and Alchemy environment variables to
already be present. Use any Doppler config that provides those values, for
example `dev_jonas`, `dev`, or a CI/test config in the `_shared` project. The
script deploys an ephemeral Alchemy stage, runs Vitest against the Worker URL,
and destroys the stage afterwards.
