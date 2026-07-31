# DevOps: Cloudflare And Doppler

This repo deploys Cloudflare apps with plain `wrangler deploy` driven by three
sources of truth:

- **`envs.ts` (repo root)** — the typed map of every deployed environment,
  per app: hostnames, worker names, and Cloudflare account. Non-secret,
  committed, reviewed. Read it before asking "what is preview_3".
- **Alchemy v2** — one stateful stack per deployed environment owns D1, KV,
  R2, and their lifecycle rules. Its generated manifest supplies every
  Wrangler binding identity: D1/KV IDs and R2 bucket names.
- **Doppler** — secrets only. One config per env per app (`prd`,
  `preview_N`, plus fully-local `dev`/`dev_<user>` that never deploy).

Alchemy and Wrangler have a strict boundary. Alchemy owns independent data
resources; Wrangler owns Workers, bindings, Durable Object classes, Browser
Rendering, loaders, entrypoints, routes, queues, containers, migrations, and
secrets. Each app keeps its small imperative deployment scripts:

| Command or script             | What                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm infra deploy`           | apply one environment's Alchemy stack and atomically generate its resource manifest                                    |
| `generate-wrangler-config.ts` | combine envs.ts + that manifest into gitignored `wrangler.jsonc` (vite dev/build regenerate it automatically)          |
| `deploy.ts`                   | `pnpm run deploy --env <name>`: build → `wrangler deploy --secrets-file` (code + secrets in one version) → smoke probe |
| `ensure-resources.ts`         | create-only Worker-adjacent setup that is outside Alchemy, currently DNS and inbound email                             |
| `pnpm infra destroy`          | delete the environment's Wrangler-owned resources, then destroy its entire Alchemy stack                               |

Small apps skip pieces they don't need (tunnels has a hand-written,
committed wrangler.jsonc and no generator; streams-example-app has no
secrets). Generated configs and Alchemy manifests are gitignored; review
`envs.ts` and
`apps/env-manager/src/alchemy/environment-resources.ts`.

`apps/env-manager` is a normal root workspace and uses the root lockfile.
Alchemy, Effect, Wrangler, and the app are therefore installed and upgraded as
one dependency graph; there is no nested package or second lockfile.

`pnpm infra` calls the deployed environment-manager Worker for every compiled
stage. One named Durable Object per environment runs the Alchemy graph and
persists Alchemy state in its own SQLite storage. The CLI atomically writes the
returned IDs to
`apps/env-manager/.alchemy/output/<stage>/cloudflare-resources.json` for the
checkout's Wrangler generators. The singleton manager lives in the preview
account and receives preview and production account tokens through separate
Cloudflare Secrets Store bindings. Its Worker uses the same Wrangler pipeline
as every other app.

Every supported deployed-environment path runs `pnpm infra deploy` immediately
before Wrangler config generation. A checkout's JSON file is disposable input,
not remote state: after destroying the environment from another checkout,
refresh it with `pnpm infra deploy` before invoking Wrangler there.

The Cloudflare resource lifecycle is deliberately fresh-stack-only. There is
no repository-owned resource import/adoption, Alchemy state reconstruction,
committed fallback ID, or compatibility mode. Alchemy's unmodified providers
retain their native deterministic-name reconciliation for an interrupted
create during an ordinary apply. Normal deploy and destroy require Alchemy's
persisted state. If that state is lost, stop: explicit operator cleanup must
remove the abandoned environment before a new stack is created; repository
code does not infer or import it.

## Environment selection is explicit

Every script takes `--env <name>` and looks the environment up in envs.ts.
In CI, `DOPPLER_CONFIG` (from the surrounding `doppler run`) is accepted as a
fallback for `deploy` — env names and Doppler config names coincide — and
every invocation asserts the Doppler-supplied `CLOUDFLARE_ACCOUNT_ID` matches
the envs.ts entry, so a wrong-config wrap fails loudly. `infra destroy`
accepts only an explicit `--env`.

## Core Doppler model

- Every independently deployable app has a Doppler project: `os`, `auth`,
  `env-manager`, `semaphore`, `tunnels`, `streams-example-app`,
  `dummy-petshop`.
- `doppler.yaml` maps directories to projects; the working directory picks
  the project unless a command passes `--project`.
- `_shared` owns values inherited by apps, including the per-environment
  Cloudflare credential sets. There are exactly three: `_shared/dev`,
  `_shared/preview`, `_shared/prd`. Never override `CLOUDFLARE_ACCOUNT_ID`
  or `CLOUDFLARE_API_TOKEN` in app or branch configs.
- The operator credential used to provision env-manager's Cloudflare API-token
  secrets needs account-level **Secrets Store Write**. Normal lifecycle calls
  use those bound secrets; Alchemy state itself lives in the environment's
  Durable Object SQLite database.
- Put values in the highest config that is correct (shared root → app
  project → branch config). Do not use Doppler personal configs; use named
  shared configs such as `dev_jonas`.

Confirm with a human before changing existing Doppler values — Doppler
changes deployed behavior without a git diff.

## Secrets vs env-shaping config

Runtime config is zod-parsed from `APP_CONFIG_*` env vars (see each app's
`config.ts`). Two delivery paths:

- **Genuinely secret** values (API keys, client secrets, signing keys) live
  in Doppler. The wrangler config's `secrets.required` lists their NAMES:
  local dev (`doppler run -- vite dev`) loads exactly those keys from
  process.env — no `.dev.vars` files — and `deploy.ts` ships their values
  atomically with the code via `wrangler deploy --secrets-file`, failing
  before upload if any are missing.
- **Env-shaping non-secrets** (base URLs, project hostname bases, the auth
  issuer) are generated into each env block's `vars` from the same envs.ts
  entry that generates the routes — they cannot drift apart and do not live
  in deployed Doppler configs at all.

Deploy scripts additionally validate the exact assembled runtime env with
the app's own zod schema before uploading anything.

## Destroying an environment

`pnpm infra destroy --env <name>` deletes the Alchemy-backed platform
environment in dependency order:

1. Container applications attached to the OS Worker's Durable Object
   namespaces, verified absent before their namespaces disappear.
2. All eight stack-dependent Workers. For each Worker, the manager discovers
   owned Durable Object classes from both its bindings and instantiated
   namespaces, uploads a no-DO stub whose declarative exports mark every owned
   class `state: "deleted"`, then deletes the script with `force=true`.
   Workers and namespaces are verified absent afterward. (`force=true` alone
   removes bindings, but not Durable Object classes or storage; legacy
   migrations are invalid once a Worker uses declarative exports.)
   Production-only `kiterate` and `tunnels-prd` are independent services, not
   members of this stack, and remain live.
3. Every repository in the OS Artifacts namespace, after no Worker can create
   more. Cloudflare has no Artifacts-namespace delete API, so the command
   drains the cursor-paginated repo listing and verifies the implicit namespace
   is empty. Each manager request deletes at most 1,000 repositories and the
   client reconnects between successful partial batches. The Durable Object
   remains explicitly `destroying` between batches and re-reads Cloudflare
   inventory rather than persisting a cursor or duplicate repository manifest.
4. The Alchemy stack: two D1 databases, two KV namespaces, two R2 buckets,
   state, and generated output.

The next automated preview deploy runs `pnpm infra deploy` and gets a fresh
stack through that slot's environment Durable Object before app deploys
recreate the Workers. Auth then reruns migrations and re-seeds its OAuth
clients using the existing `AUTH_SEED_OAUTH_CLIENTS` lifecycle. A production
recreation must also restore Semaphore's preview-slot inventory:

```bash
doppler run --project semaphore --config prd -- \
  pnpm --dir apps/semaphore seed:environment-config-leases
```

Routes and create-only DNS records are reattached by normal deployment.

Production destroy is dashboard-only and requires a production Iterate Auth
browser session at the Worker boundary. Forge-signed bearer tokens available
to CI can deploy/check production but cannot destroy it. Destroying production
or migrating an existing fleet remains an explicit operator action; a code
merge is not permission to erase live environments. Quiesce automatic deploys
before the merge that introduces the Alchemy-backed push workflows. Destroy an
environment before removing its stage from `envs.ts`; the all-at-once migration
destroys every environment and recreates each stack from empty.

## Bringing up a new environment

For a new preview slot, use [Adding preview slots](adding-preview-slots.md).
Preview slots also require lease inventory, OAuth audiences, Doppler branch
configs, external integration apps, and fleet verification; the steps below
cover only the shared Cloudflare resource/deploy skeleton.

1. Add the entry to `envs.ts` with `previewSlot(N)`; there are no physical
   resource IDs to fill in.
2. Run `pnpm infra deploy --env <name>` once. Validate
   `apps/env-manager/.alchemy/output/<name>/cloudflare-resources.json`, then
   run the command again and require the same physical IDs.
3. Run each app's `ensure-resources` for DNS and other Worker-adjacent setup.
   A brand-new OS Worker defers its inbound-email catch-all until deploy because
   Cloudflare does not accept a route to a missing script.
4. Commit the environment and stack definitions. Generated manifests and
   `wrangler.jsonc` files are never committed.
5. For a brand-new environment, deploy Auth first so Cloudflare can resolve
   OS's service binding. Then deploy the remaining apps. Subsequent preview
   revisions may fan out because every Worker already exists and all apps
   derive the same signing key from Doppler. Production always uses the single
   serialized `Deploy Cloudflare Platform` workflow. The OS deploy also
   requires the post-upload inbound-email catch-all to reconcile.

## Environment-manager authentication

The singleton environment-manager Worker is deployed in the preview account
but signs users in through `https://auth.iterate.com`. It deliberately uses the
same OAuth-client dance as the existing production relying parties: run

```bash
doppler run --project auth --config prd -- \
  pnpm --dir apps/env-manager sync-auth-client
```

to ensure the client through Auth's internal API, write its ID and secret to
`env-manager/prd`, and mirror it into `auth/prd`'s
`AUTH_SEED_OAUTH_CLIENTS`. Normal Auth deployment continues to seed that
declarative list. No static client ID or alternate Auth behavior is compiled
into env-manager.

## Cloudflare accounts

- prd: `04b3b57291ef2626c6a8daa9d47065a7` (iterate.com zones)
- dev/preview: `376ef7ed81b0573f93524de763666c15` (iterate-preview-N, dev zones)

Both are declared in envs.ts; scripts never guess.
