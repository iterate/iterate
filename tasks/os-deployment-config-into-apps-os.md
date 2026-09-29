---
status: in-progress
size: medium
---

# apps/os builds without the root envs.ts

Pre-work for moving apps/os into `core/` (Tuple 9/29: "core/ builds from a clone of itself"; the
copybara0929 experiment, iterate/iterate#3434). Outside code may import core; core never imports
outside code. The root `envs.ts` stays outside: it names iterate's accounts, zones, KV/D1 ids and
admins, and does not belong in the public repo.

Today apps/os reaches `envs.ts` in two ways:

1. **Things that are really apps/os's own** and only live in envs.ts by history:
   `PROJECT_CONTEXT_BIRTH_EVENTS` (the same in every deployment), the `OsEnv` shape and
   `osResourceNames`, and prd's dash URL (which the self-host config reads).
2. **The lookup**: `vite.config.ts` → `viteWranglerConfig(CLOUDFLARE_ENV)` → `getOsEnv(name)` finds
   prd, preview and `pr<n>-<sha7>` in envs.ts, and local dev uses `PREVIEW_AND_DEV_ACCOUNT_ID`.

Plan ("split the difference"): move (1) into apps/os now and invert (2), so apps/os builds
self-host and local dev by itself and iterate's deploy tooling hands it every other deployment.

Status: PR 1 (the moves, iterate/iterate#3447) done; every deployment's config is unchanged. PR 2 (the lookup, stacked on it) in progress. Open question: where local dev's Cloudflare account comes from (below).

## PR 1: the moves (no behaviour change)

- [x] `PROJECT_CONTEXT_BIRTH_EVENTS` → `apps/os/src/project/context-birth-events.ts` _pure, like test-email-domain.ts, so the Vite config imports it as is_
- [x] `OsEnv` and `osResourceNames` → `apps/os/scripts/os-env.ts`; envs.ts imports the type _comments that named envs.ts constants now say envs.ts explicitly_
- [x] self-host config names `https://dash.iterate.com` itself instead of reading `osEnvs.prd` _generate-wrangler-config.ts `selfHostWranglerConfig`_
- [x] every importer imports from the new home (no re-exports from envs.ts) _8 files in apps/os, plus comments that pointed at envs.ts_
- [x] proof: every deployment's generated wrangler config is byte-identical before and after
      (prd, preview, a `pr<n>-<sha7>`, self-host, local build, local dev) _`viteWranglerConfig` for each, JSON diffed: identical_

## PR 2: the lookup (stacked on PR 1)

- [ ] `viteWranglerConfig` takes the deployment, not its name: an `OsDeployment` (an `OsEnv` plus
      `name`), "self-host", or none for local. vite.config.ts reads it from the environment:
      `CLOUDFLARE_ENV` names it and `OS_DEPLOYMENT` is its JSON, parsed with zod. A name with no
      `OS_DEPLOYMENT` throws.
- [ ] `buildOs(deployment)` takes the looked-up deployment and sets `OS_DEPLOYMENT`; the callers
      (scripts/deploy.ts through `deployApp`, scripts/preview.ts) pass `getOsEnv(name)`
- [ ] ~~local dev's `account_id` comes from the caller (`CLOUDFLARE_ACCOUNT_ID`, which iterate's dev
      tooling sets) instead of `PREVIEW_AND_DEV_ACCOUNT_ID`~~ _deferred to an open question: nothing
      sets it today. `pnpm dev`, the Playwright web server and `pnpm e2e` run without Doppler._
- [ ] the build path stops reaching envs.ts through scripts/lib: build.ts imports `viteBuild` from
      deploy-helpers.ts, which reaches envs.ts through env-context.ts `UNPROVISIONED`. `viteBuild`
      moves to a module of its own that imports nothing, as scripts/lib/wrangler-config.ts already
      does. Moving either into apps/os waits for the core/ move.
- [ ] a test that lists every file outside apps/os and packages/ the build path reaches (esbuild's
      metafile), so a new one shows up in review

## Assumptions (made without asking)

- Two PRs, the second stacked on the first, so the pure moves can merge on their own.
- The type and helpers keep their names (`OsEnv`, `osResourceNames`): renaming them to
  "deployment" words is a separate bikeshed.
- The internal scripts in apps/os/scripts (deploy, ensure-resources, erase-data, preview*,
  project-seed, seed-instance-secrets) keep importing envs.ts. Moving them out of apps/os is its
  own task.

## Open question: local dev's Cloudflare account

Local dev and the local build (`pnpm dev`, `pnpm e2e`, the Playwright web server) proxy Artifacts,
AI and Browser to a real account, today `PREVIEW_AND_DEV_ACCOUNT_ID` from envs.ts. A self-hoster's
local dev wants their own account. Options:

1. `account_id` from `CLOUDFLARE_ACCOUNT_ID` (wrangler's own variable), and iterate's entry points set
   it: root `pnpm dev` and playwright.config.ts can import envs.ts, but `pnpm --dir apps/os e2e`
   and a bare `pnpm dev` inside apps/os would need it in the shell.
2. No `account_id`: wrangler takes the login's account. It asks when a login spans several, and a
   non-interactive run fails naming `CLOUDFLARE_ACCOUNT_ID`.
3. Keep iterate's dev account in apps/os as local dev's default, overridden by
   `CLOUDFLARE_ACCOUNT_ID`. Core then names one iterate account id (not a secret).

## Out of scope

- packages/shared and packages/ui (where they go in the core/ world)
- moving internal tooling out of apps/os/scripts
- whether `APP_CONFIG_CONTEXT_BIRTH_EVENTS` should become the worker's default rather than a var

## Implementation notes

- PR 1: after the moves, apps/os's build path still reaches envs.ts for `getOsEnv` and
  `PREVIEW_AND_DEV_ACCOUNT_ID` (generate-wrangler-config.ts) and `UNPROVISIONED` (build.ts →
  scripts/lib/deploy-helpers.ts → env-context.ts). Those are PR 2.
- PR 1 checks: lint, oxfmt, `pnpm typecheck`, knip, `pnpm --filter os test` (147 files) all pass.
