# DevOps: Cloudflare And Doppler

This repo deploys Cloudflare apps with plain `wrangler deploy` driven by three
sources of truth:

- **`envs.ts` (repo root)** — the typed map of every deployed environment,
  per app: hostnames, worker names, and Cloudflare account. Non-secret,
  committed, reviewed. Read it before asking "what is preview_3".
- **Alchemy v2** — one stateful stack per deployed environment owns D1, KV,
  R2, and their lifecycle rules. Its generated manifest supplies D1/KV IDs to
  the Wrangler config generators; R2 bindings use deterministic worker-based
  names.
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
`envs.ts` and `infra/alchemy.run.ts`.

`infra` has its own lockfile so Alchemy's beta dependency graph cannot alter
application resolutions. The `pnpm infra` command installs that exact nested
lock before deploy or destroy; the root lockfile contains no Alchemy packages.

The lifecycle is deliberately fresh-stack-only. There is no repository import,
adoption, state reconstruction, committed fallback ID, or compatibility mode.
Alchemy's providers can silently reuse same-name objects after create
collisions, so a destructive cutover must prove those names absent before the
first apply. If a stack's state is lost or irreparably inconsistent, destroy
that named environment's data resources and recreate it.

## Environment selection is explicit

Every script takes `--env <name>` and looks the environment up in envs.ts.
In CI, `DOPPLER_CONFIG` (from the surrounding `doppler run`) is accepted as a
fallback for `deploy` — env names and Doppler config names coincide — and
every invocation asserts the Doppler-supplied `CLOUDFLARE_ACCOUNT_ID` matches
the envs.ts entry, so a wrong-config wrap fails loudly. `infra destroy`
accepts only an explicit `--env`.

## Core Doppler model

- Every independently deployable app has a Doppler project: `os`, `auth`,
  `semaphore`, `tunnels`, `streams-example-app`, `dummy-petshop`.
- `doppler.yaml` maps directories to projects; the working directory picks
  the project unless a command passes `--project`.
- `_shared` owns values inherited by apps, including the per-environment
  Cloudflare credential sets. There are exactly three: `_shared/dev`,
  `_shared/preview`, `_shared/prd`. Never override `CLOUDFLARE_ACCOUNT_ID`
  or `CLOUDFLARE_API_TOKEN` in app or branch configs.
- The Cloudflare API tokens must include account-level **Secrets Store Write**.
  Alchemy's official remote state store keeps its bearer token and encryption
  key in Cloudflare Secrets Store; without that permission even the first
  `pnpm infra deploy` fails before creating D1, KV, or R2.
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

`pnpm infra destroy --env <name>` deletes the whole environment in dependency
order:

1. Every repository in the OS Artifacts namespace. Cloudflare has no
   Artifacts-namespace delete API, so the command verifies the implicit
   namespace is empty.
2. Container applications attached to the OS Worker's Durable Object
   namespaces, verified absent before their namespaces disappear.
3. All seven environment Workers with Cloudflare's `force=true` API. This is
   the supported whole-namespace Durable Object teardown: the scripts' DO
   namespaces, instances, storage, and alarms are deleted with them.
4. The Alchemy stack: two D1 databases, two KV namespaces, two R2 buckets,
   state, and generated output.

The next preview acquisition runs `pnpm infra deploy` and gets a fresh stack
before app deploys recreate the Workers. Auth then reruns migrations and
re-seeds its OAuth clients. Routes and create-only DNS records are reattached
by normal deployment.

Production requires `--yes-i-mean-prd`. Destroying production or migrating an
existing fleet remains an explicit operator action; a code merge is not
permission to erase live environments. Quiesce automatic deploys before the
merge that introduces the Alchemy-backed push workflows. The all-at-once
migration destroys every environment and recreates each stack from empty.

## Bringing up a new environment

For a new preview slot, use [Adding preview slots](adding-preview-slots.md).
Preview slots also require lease inventory, OAuth audiences, Doppler branch
configs, external integration apps, and fleet verification; the steps below
cover only the shared Cloudflare resource/deploy skeleton.

1. Add the entry to `envs.ts` with `previewSlot(N)`; there are no physical
   resource IDs to fill in.
2. Run `pnpm infra deploy --env <name>` once. Validate
   `infra/output/<name>/cloudflare-resources.json`, then run the command again
   and require the same physical IDs.
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

## Cloudflare accounts

- prd: `04b3b57291ef2626c6a8daa9d47065a7` (iterate.com zones)
- dev/preview: `376ef7ed81b0573f93524de763666c15` (iterate-preview-N, dev zones)

Both are declared in envs.ts; scripts never guess.
