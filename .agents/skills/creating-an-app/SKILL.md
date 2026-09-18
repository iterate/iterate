---
name: creating-an-app
description: Create a new Cloudflare app in this repo with the expected package scripts, Doppler shape, and CI workflow wiring.
---

# Creating An App

Use this when adding a new Cloudflare app under `apps/`.

Keep the app contract small. Each app owns a handful of `tsx` scripts under
`apps/<app>/scripts/`, exposed as package scripts and built on the shared deploy
primitives in `scripts/lib/` (see `scripts/lib/deploy-app.ts`):

- `deploy` — `pnpm run deploy --env <name>` (build → wrangler deploy with atomic
  secrets → smoke)
- `ensure-resources` — create-only Cloudflare resource provisioning
- `erase-data` — wipe an env's data without deleting the worker
- `gen:wrangler` — expand the generated, gitignored `wrangler.jsonc` from the
  root `envs.ts`
- `test:e2e` if the app has live preview tests

A TanStack Start app on Workers with no server data of its own (dash, agents,
notes, voice) does not copy these: it declares itself in `scripts/app.ts` (see
`apps/notes/scripts/app.ts`) and gets every script from
`scripts/lib/start-app.ts`.

The package scripts should own only the app action. Doppler selection belongs
outside the app script (`doppler run --config <env> -- pnpm run deploy`).

## CI Workflows

CI and deploy workflows are hand-written Depot CI YAML in `.depot/workflows/`
(see `docs/depot-ci.md`).

The current pattern is:

1. Copy an existing deploy workflow (for example
   `.depot/workflows/deploy-semaphore.yml`) to
   `.depot/workflows/deploy-<app>.yml` and edit the app name, Doppler project,
   deploy command, and `paths` filters directly.
2. If the app participates in PR previews, wire it into the repo preview
   router in `scripts/preview/preview.ts`.
3. Depot registers triggers from the default branch, so a new workflow file
   only starts running after it lands on `main`.

Preview deploys do not live in app-local routers anymore. They run through the repo preview router:

```bash
doppler run --project _shared --config prd -- pnpm preview sync --pull-request-number 1234
doppler run --project _shared --config prd -- pnpm preview cleanup --pull-request-number 1234
```

Workflow rules:

- PR pushes deploy a leased `preview_N`
- pushes to `main` deploy `prd`
- PR deploys update the managed preview section in the PR body
- `main` deploy successes and failures post to Slack via `scripts/ci/notify.ts`

Do not add preview logic back into `apps/<app>/scripts/router.ts` just to satisfy CI.

## Doppler

For a new Doppler project or config inheritance, read [Doppler setup](references/doppler.md).

The app package should work with:

```bash
doppler run --project <app> --config preview_2 -- pnpm run deploy --env preview_2
doppler run --project <app> --config prd -- pnpm run deploy --env prd
```
