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

| Script                        | What                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `generate-wrangler-config.ts` | expands envs.ts into the gitignored `wrangler.jsonc` (vite dev/build regenerate it automatically)                      |
| `deploy.ts`                   | `pnpm run deploy --env <name>`: build → `wrangler deploy --secrets-file` (code + secrets in ONE version) → smoke probe |
| `ensure-resources.ts`         | create-only bring-up (D1/KV/DNS); reconciles new IDs back into envs.ts                                                 |
| `erase-data.ts`               | wipe an env's data; infrastructure stays (see below)                                                                   |

Small apps skip pieces they don't need (tunnels has a hand-written,
committed wrangler.jsonc and no generator; streams-example-app has no
secrets). Generated configs are gitignored — envs.ts is what you review.

## Environment selection is explicit

Deployment scripts take `--env <name>` and looks the environment up in envs.ts.
In CI, `DOPPLER_CONFIG` (from the surrounding `doppler run`) is accepted as a
fallback for `deploy` — env names and Doppler config names coincide — and
every invocation asserts the Doppler-supplied `CLOUDFLARE_ACCOUNT_ID` matches
the envs.ts entry, so a wrong-config wrap fails loudly. Destructive scripts
(`erase-data`) accept only the explicit flag.

Account-wide tools such as `ai-gateway-budgets` instead take `--account prd` or
`--account dev/preview`. The `cloudflareAccounts` map in `envs.ts` associates those
exact names with account IDs and their `_shared` Doppler credential sources.
They reuse the same account-ID validation without selecting a preview slot.

## Core Doppler model

- Every independently deployable app has a Doppler project: `os`, `auth`,
  `semaphore`, `tunnels`, `streams-example-app`, `dummy-petshop`.
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

`pnpm erase-data --env <name>` (in apps/os) retires ordinary Durable Object
classes, wipes Auth D1 and project-directory KV, and sweeps Artifacts repos.
The OS Worker stays deployed but serves 503 until redeployed. Current sandbox
container classes are retained because of Cloudflare's recreation limitation;
their existing idle cleanup remains responsible for stopping containers.
Redeploy Auth too: its OAuth clients were erased and need reseeding.

Normal preview runs reset before and after tests with `--preserve-artifacts`.
The flag skips repository listing/deletion only; DO, D1, KV and R2 lifecycle
handling stays unchanged. Full sweeps still run on PR close, explicit reclaim,
expiry GC and ordinary operator erasure. `--preserve-auth` also continues to
preserve repositories for deliberate project recreation. Manual lease release
alone does not erase data.

## Bringing up a new environment

For a new preview slot, use [Adding preview slots](adding-preview-slots.md).
Preview slots also require lease inventory, OAuth audiences, Doppler branch
configs, external integration apps, and fleet verification; the steps below
cover only the shared Cloudflare resource/deploy skeleton.

1. Add the entry to envs.ts (preview slots: `previewSlot(N, {...UNPROVISIONED})`).
2. `pnpm ensure-resources --env <name>` per app — creates missing D1/KV/DNS
   and prints the IDs to paste into envs.ts. A brand-new OS Worker defers its
   inbound-email catch-all until deploy because Cloudflare does not accept a
   route to a missing script.
3. Commit envs.ts (wrangler.jsonc is generated on demand, never committed).
4. After Doppler and resources are ready, deploy auth and os concurrently.
   Both consume one Doppler-owned signing key; os derives only its public half
   and never waits for auth's JWKS endpoint. A brand-new environment still
   needs the auth service to exist before Cloudflare can resolve os's service
   binding, but subsequent revisions have no JWT-driven deployment order. The
   os deploy also requires the post-upload inbound-email catch-all to
   reconcile.

## Cloudflare accounts

- prd: `04b3b57291ef2626c6a8daa9d47065a7` (iterate.com zones)
- dev/preview: `376ef7ed81b0573f93524de763666c15` (iterate-preview-N, dev zones)

Both are declared in envs.ts; scripts never guess.
