# DevOps: Cloudflare And Doppler

This repo deploys Cloudflare apps with plain `wrangler deploy` driven by two
sources of truth:

- **`envs.ts` (repo root)** — the typed map of every deployed environment,
  per app: hostnames, worker names, Cloudflare account, and the IDs of the
  few Cloudflare resources an env owns (D1, KV). Non-secret, committed,
  reviewed. Read it before asking "what is preview_3".
- **Doppler** — secrets only. One config per env per app (`prd`,
  `preview_N`, plus fully-local `dev`/`dev_<user>` that never deploy).

There is no IaC framework and no deploy-time state store. Each app carries a
small set of rhyming imperative scripts in `apps/<app>/scripts/`:

| Script                              | What                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| `generate-wrangler-config.ts`       | expands envs.ts into the checked-in `wrangler.jsonc` env blocks (`pnpm gen:wrangler`; `--check` chained into typecheck) |
| `deploy.ts`                         | `pnpm run deploy --env <name>`: build → `wrangler deploy --secrets-file` (code + secrets in ONE version) → smoke probe |
| `ensure-resources.ts`               | create-only bring-up (D1/KV/DNS); reconciles new IDs back into envs.ts |
| `erase-data.ts`                     | wipe an env's data; infrastructure stays (see below)                 |

Small apps skip pieces they don't need (tunnels has a hand-written
wrangler.jsonc and no generator; streams-example-app has no secrets).

## Environment selection is explicit

Every script takes `--env <name>` and looks the environment up in envs.ts.
In CI, `DOPPLER_CONFIG` (from the surrounding `doppler run`) is accepted as a
fallback for `deploy` — env names and Doppler config names coincide — and
every invocation asserts the Doppler-supplied `CLOUDFLARE_ACCOUNT_ID` matches
the envs.ts entry, so a wrong-config wrap fails loudly. Destructive scripts
(`erase-data`) accept only the explicit flag.

## Core Doppler model

- Every independently deployable app has a Doppler project: `os`, `auth`,
  `semaphore`, `tunnels`, `streams-example-app`, `iterate-com`.
- `doppler.yaml` maps directories to projects; the working directory picks
  the project unless a command passes `--project`.
- `_shared` owns values inherited by apps, including the per-environment
  Cloudflare credential sets. There are exactly three: `_shared/dev`,
  `_shared/preview`, `_shared/prd`. Never override `CLOUDFLARE_ACCOUNT_ID`
  or `CLOUDFLARE_API_TOKEN` in app or branch configs.
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

## Workers are never deleted

Deploys only ever upsert. Routes are declared in wrangler config
(re-ensured on every deploy); DNS records are created once by
`ensure-resources` (create-only) and never touched again. This makes the
historical zombie-route/522 failure class (script deletion cascading route
deletion at the edge) structurally impossible — there is no destroy, no
"parking", and no route-healing machinery.

## Erasing an environment

`pnpm erase-data --env <name>` (in apps/os) wipes the auth D1 rows and the
project-directory KV. Durable Objects are addressed by project id, so with
those gone every existing DO becomes a permanently unreachable orphan and
the env is logically pristine with zero downtime — orphaned DO storage costs
pennies and there is no Cloudflare API to delete DO instances. Redeploy auth
afterwards (OAuth clients are data too; its deploy re-seeds them). Preview
slots persist data across pushes; erasing is an explicit action, not part of
deploys.

## Bringing up a new environment

1. Add the entry to envs.ts (preview slots: `previewSlot(N, {...UNPROVISIONED})`).
2. `pnpm ensure-resources --env <name>` per app — creates missing D1/KV/DNS
   and prints the IDs to paste into envs.ts.
3. Commit, `pnpm gen:wrangler`, commit the regenerated wrangler.jsonc.
4. Deploy auth first (`pnpm --dir apps/auth run deploy --env <name>`), then
   os (its deploy bakes auth's JWKS and fails fast if auth isn't serving).

## Cloudflare accounts

- prd: `04b3b57291ef2626c6a8daa9d47065a7` (iterate.com zones)
- dev/preview: `376ef7ed81b0573f93524de763666c15` (iterate-preview-N, dev zones)

Both are declared in envs.ts; scripts never guess.
