# Environment manager

`apps/env-manager` is the single control plane for disposable preview
environments. It is a TanStack Start Worker deployed to the preview Cloudflare
account at `envs.iterate-dev.com`, with a dashboard protected by production
Iterate Auth.

## Programming model

The resource graph lives in
`src/alchemy/environment-resources.ts` and creates exactly six resources for a
platform environment: Auth D1, Semaphore D1, project-directory KV,
worker-build-cache KV, files R2, and sandboxes R2.

The same graph has two runners:

- Preview stages run inside one named `EnvironmentDurableObject` per slot.
  The Durable Object serializes lifecycle operations, stores Alchemy state in
  its SQLite database, and publishes operation/resource state through
  LiveState.
- Production and the Auth-only `dev_global` stage run from
  `scripts/cli.ts` using Alchemy's Cloudflare state provider. They remain local
  CI/operator actions.

`pnpm infra deploy --env <stage>` is the root entry point. For previews it
calls the deployed Durable Object and atomically materializes the returned IDs
at `.alchemy/output/<stage>/cloudflare-resources.json`. Existing app
generators read that strict manifest and produce ordinary gitignored
`wrangler.jsonc` files.

Alchemy owns D1, KV, and R2. Wrangler owns Workers, Durable Object classes and
storage, bindings, routes, Browser Rendering, loaders, entrypoints,
containers, migrations, and secrets. Destroy removes Wrangler-owned resources
first, then the Alchemy stack. There is no import, adoption, state
reconstruction, or legacy-ID fallback: a broken environment is destroyed and
recreated.

## Commands

```bash
# Preview: calls the deployed environment-manager Worker.
pnpm infra deploy --env preview_9
pnpm infra check --env preview_9
pnpm infra status --env preview_9
pnpm infra destroy --env preview_9

# Production: runs the same Alchemy graph locally.
pnpm infra deploy --env prd
pnpm infra destroy --env prd --yes-i-mean-prd
```

The Worker itself deploys with:

```bash
pnpm --dir apps/env-manager deploy
```

It always targets the preview Cloudflare account even though its Doppler
configuration is named `prd`.

## Auth client

Environment manager uses the repository's existing production OAuth-client
seed/sync lifecycle; Auth itself has no special env-manager path. Provision or
repair its relying-party client with:

```bash
doppler run --project auth --config prd -- \
  pnpm --dir apps/env-manager sync-auth-client
```

The script ensures the client through Auth's existing internal API, stores the
credentials in `env-manager/prd`, and upserts the same entry into
`auth/prd`'s `AUTH_SEED_OAUTH_CLIENTS` so normal Auth deployments recreate it
after a database reset.
