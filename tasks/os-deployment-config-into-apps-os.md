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

Status: PR 1 (the moves) in progress. PR 2 (the lookup) not started.

## PR 1: the moves (no behaviour change)

- [ ] `PROJECT_CONTEXT_BIRTH_EVENTS` → `apps/os/src/project/context-birth-events.ts`
- [ ] `OsEnv` and `osResourceNames` → `apps/os/scripts/os-env.ts`; envs.ts imports the type
- [ ] self-host config names `https://dash.iterate.com` itself instead of reading `osEnvs.prd`
- [ ] every importer imports from the new home (no re-exports from envs.ts)
- [ ] proof: every deployment's generated wrangler config is byte-identical before and after
      (prd, preview, a `pr<n>-<sha7>`, self-host, local build, local dev)

## PR 2: the lookup (stacked on PR 1)

- [ ] `viteWranglerConfig`: "self-host" and local as today; any other name reads its deployment
      from `OS_DEPLOYMENT` (JSON of an `OsEnv` plus `name`, parsed with zod) and throws without it
- [ ] `buildOs(deployment)` takes the looked-up deployment and sets `OS_DEPLOYMENT`; the callers
      (scripts/deploy.ts through `deployApp`, scripts/preview.ts) pass `getOsEnv(name)`
- [ ] local dev's `account_id` comes from the caller (`CLOUDFLARE_ACCOUNT_ID`, which iterate's dev
      tooling sets) instead of `PREVIEW_AND_DEV_ACCOUNT_ID`
- [ ] the build path (build.ts, vite.config.ts, generate-wrangler-config.ts) imports nothing outside
      apps/os and packages/: build.ts stops importing `viteBuild` from scripts/lib/deploy-helpers.ts
      (which reaches envs.ts through env-context.ts `UNPROVISIONED`), and the wrangler-config
      helpers it needs move into apps/os
- [ ] a test that fails when the build path imports envs.ts again

## Assumptions (made without asking)

- Two PRs, the second stacked on the first, so the pure moves can merge on their own.
- The type and helpers keep their names (`OsEnv`, `osResourceNames`): renaming them to
  "deployment" words is a separate bikeshed.
- The internal scripts in apps/os/scripts (deploy, ensure-resources, erase-data, preview*,
  project-seed, seed-instance-secrets) keep importing envs.ts. Moving them out of apps/os is its
  own task.

## Out of scope

- packages/shared and packages/ui (where they go in the core/ world)
- moving internal tooling out of apps/os/scripts
- whether `APP_CONFIG_CONTEXT_BIRTH_EVENTS` should become the worker's default rather than a var

## Implementation notes
