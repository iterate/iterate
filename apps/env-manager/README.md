# Environment manager

`apps/env-manager` is the control plane for every deployed environment. It is a
TanStack Start Worker deployed to the preview Cloudflare account at
`envs.iterate-dev.com`, with a dashboard protected by production Iterate Auth.

## Programming model

The resource graph lives in
`src/alchemy/environment-resources.ts` and creates exactly six resources for a
platform environment: Auth D1, Semaphore D1, project-directory KV,
worker-build-cache KV, files R2, and sandboxes R2.

Every compiled stage, including production and Auth-only `dev_global`, has one
named `EnvironmentDurableObject`. The Durable Object runs the Effect/Alchemy
program, serializes lifecycle operations, stores Alchemy state in its SQLite
database, and publishes operation/resource state through LiveState. The
environment inventory is compiled from the root `envs.ts`; changing it requires
redeploying env-manager.

`pnpm infra deploy --env <stage>` is the root entry point. Its thin local CLI
calls the deployed Durable Object and atomically materializes the returned IDs
at `.alchemy/output/<stage>/cloudflare-resources.json`. Existing app generators
read that strict manifest and produce ordinary gitignored `wrangler.jsonc`
files. Cloudflare API tokens stay in Cloudflare Secrets Store; operators do not
send them through the CLI.

Alchemy owns D1, KV, and R2. Wrangler owns Workers, Durable Object classes and
storage, bindings, routes, Browser Rendering, loaders, entrypoints,
containers, migrations, and secrets. Destroy removes Wrangler-owned resources
first: it deletes containers, replaces each Worker with a 410 stub whose
declarative exports tombstone every discovered Durable Object class, deletes
the Workers and Artifacts repositories, and verifies their absence. It then
destroys the Alchemy stack. There is no application-level import, adoption,
state reconstruction, or legacy-ID fallback: a broken environment is destroyed
and recreated. During an ordinary apply, Alchemy's unmodified providers retain
their native deterministic-name reconciliation for interrupted creates.

Artifact drains run as explicit batches of at most 1,000 repositories. The
client reconnects after each successful partial result; the Durable Object
retains a settled `destroying` lifecycle and refuses deploy/check until destroy
converges. Cloudflare may also restart a Durable Object and terminate its
WebSocket. The manager durably distinguishes that exact interruption from a
resource failure; the client may continue only that classified destroy for the
same operation ID, within the same hard 100-batch limit and after a fresh
exact-token fence check before each batch. Cloudflare inventory, not a stored
cursor or repository count, is the checkpoint for every batch.

## Commands

```bash
# Every command calls the deployed environment-manager Worker.
pnpm infra deploy --env preview_9
pnpm infra check --env preview_9
pnpm infra status --env preview_9
pnpm infra destroy --env preview_9

pnpm infra deploy --env prd
```

Production destroy is intentionally dashboard-only. The Worker requires a
production Iterate Auth browser session at the server boundary; the
forge-signed bearer available to CI can deploy and check production but cannot
destroy it.

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
