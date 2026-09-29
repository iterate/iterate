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

Status: PR 1 (the moves, iterate/iterate#3447) done; every deployment's config is unchanged. PR 2 (the lookup, iterate/iterate#3448, stacked on it) done: every build gets its deployment from the caller, and the configs are unchanged. Local dev's account: option 1 (below). The build reaches envs.ts no more: the pet shop's origin is the deployment's too.

## PR 1: the moves (no behaviour change)

- [x] `PROJECT_CONTEXT_BIRTH_EVENTS` → `apps/os/src/project/context-birth-events.ts` _pure, like test-email-domain.ts, so the Vite config imports it as is_
- [x] `OsEnv` and `osResourceNames` → `apps/os/scripts/os-env.ts`; envs.ts imports the type _comments that named envs.ts constants now say envs.ts explicitly_
- [x] self-host config names `https://dash.iterate.com` itself instead of reading `osEnvs.prd` _generate-wrangler-config.ts `selfHostWranglerConfig`_
- [x] every importer imports from the new home (no re-exports from envs.ts) _8 files in apps/os, plus comments that pointed at envs.ts_
- [x] proof: every deployment's generated wrangler config is byte-identical before and after
      (prd, preview, a `pr<n>-<sha7>`, self-host, local build, local dev) _`viteWranglerConfig` for each, JSON diffed: identical_

## PR 2: the lookup (stacked on PR 1)

- [x] `viteWranglerConfig` takes the deployment, not its name: an `OsDeployment` (an `OsEnv` plus
      `name`), "self-host", or none for local. vite.config.ts reads it from the environment:
      `CLOUDFLARE_ENV` names it and `OS_DEPLOYMENT` is its JSON, parsed with zod. A name with no
      `OS_DEPLOYMENT` throws. _generate-wrangler-config.ts `deploymentFromEnv`; `OsEnv` is a zod schema in scripts/os-env.ts_
- [x] `buildOs(deployment)` takes the looked-up deployment and sets `OS_DEPLOYMENT`; the callers
      (scripts/deploy.ts through `deployApp`, scripts/preview.ts) pass `getOsEnv(name)` _build.ts
      `viteBuildOs`; deploy.ts passes it as deployApp's `build`_
- [x] local dev's `account_id` comes from the caller (`CLOUDFLARE_ACCOUNT_ID`) instead of
      `PREVIEW_AND_DEV_ACCOUNT_ID` _Misha picked option 1: the local config sets no account and
      wrangler reads CLOUDFLARE_ACCOUNT_ID itself; root `pnpm dev` and the specs' local worker run
      apps/os's dev through scripts/os-dev.ts, which sets the dev/preview account_
- [x] the build path stops reaching envs.ts through scripts/lib: build.ts imports `viteBuild` from
      deploy-helpers.ts, which reaches envs.ts through env-context.ts `UNPROVISIONED`. `viteBuild`
      moves to a module of its own that imports nothing, as scripts/lib/wrangler-config.ts already
      does. Moving either into apps/os waits for the core/ move. _scripts/lib/vite-build.ts; its
      `env` argument replaces the name, so apps/os passes `OS_DEPLOYMENT` too_
- [x] a test that lists every file outside apps/os and packages/ the build path reaches (esbuild's
      metafile), so a new one shows up in review _apps/os/scripts/build.test.ts: envs.ts (local
      dev's account only), scripts/lib/vite-build.ts, scripts/lib/wrangler-config.ts_

## Assumptions (made without asking)

- Two PRs, the second stacked on the first, so the pure moves can merge on their own.
- The type and helpers keep their names (`OsEnv`, `osResourceNames`): renaming them to
  "deployment" words is a separate bikeshed.
- The internal scripts in apps/os/scripts (deploy, ensure-resources, erase-data, preview*,
  project-seed, seed-instance-secrets) keep importing envs.ts. Moving them out of apps/os is its
  own task.

## Decided: local dev's Cloudflare account (option 1)

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
- PR 2: `OsEnv` as a zod schema rewrites objects in the schema's key order, and `projectWildcard`
  goes into a var as JSON, so its fields follow envs.ts's order (the diff caught prd's
  `APP_CONFIG_URLS__PROJECT_WILDCARD` reordering).
- PR 2 proof: `viteWranglerConfig` through `deploymentFromEnv` (the JSON round trip `viteBuildOs`
  makes) for all six configs is byte-identical to main's. A real `vite build` of prd, by main's
  `CLOUDFLARE_ENV=prd` and by this branch's `buildOs(getOsEnv("prd"))`, writes the same
  wrangler.json. A bare `CLOUDFLARE_ENV=prd vite build` fails naming `OS_DEPLOYMENT`, and
  `CLOUDFLARE_ENV=self-host pnpm --filter os build` (the recipe's) still builds.
- PR 2 checks: lint, oxfmt, `pnpm typecheck`, knip, `pnpm --filter os test` (148 files),
  scripts/lib and context-sweep tests all pass.
- PR 2, option 1: the local build's wrangler.json no longer names an account. Root `pnpm dev start
--detach` through scripts/os-dev.ts answered `/version`, its process carried the dev/preview
  CLOUDFLARE_ACCOUNT_ID, and wrangler established the remote connection for Artifacts, AI and
  Browser.
- The pet shop: `petshopIntegrations: true` became `petshopOrigin` (envs.ts `previewDeployment`
  sets `dummyPetshopEnvs.prd.baseUrl`). The scripts/preview-*-app.ts fakes lost their `…Origin`
  field and the generator (deploy.ts for GitHub's) adds it from the deployment, in the same key
  position: every config and the GitHub App secret are byte-identical. The e2e and specs used only
  ids, slugs, secrets and the key, so they are unchanged. build.test.ts now lists no envs.ts.
