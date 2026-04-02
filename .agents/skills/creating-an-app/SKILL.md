---
name: creating-an-app
description: Create a new Cloudflare app in this repo with the expected package scripts, Doppler shape, and CI workflow wiring.
publish: false
---

# Creating An App

Use this when adding a new Cloudflare app under `apps/`.

Keep the app contract small:

- `alchemy:up`
- `alchemy:down`
- `test:e2e` if the app has live preview tests

The package scripts should own only the app action. Doppler selection belongs outside the app script.

## CI Workflows

Cloudflare deploy workflows are generated from `.github/ts-workflows/`.

The current pattern is:

1. Add the app to `scripts/preview/apps.ts`.
2. Add a thin workflow entry in `.github/ts-workflows/workflows/deploy-<app>.ts`.
3. Regenerate YAML with `pnpm -C .github/ts-workflows generate`.

The shared app manifest is the source of truth for:

- app slug
- display name
- repo path
- Doppler project
- path filters
- preview resource type
- preview test base URL env var
- preview test command

Preview deploys do not live in app-local routers anymore. They run through the repo preview router:

```bash
doppler run --project semaphore --config prd -- pnpm preview sync --app <slug>
doppler run --project semaphore --config prd -- pnpm preview cleanup --app <slug>
```

Workflow rules:

- PR pushes deploy `stg`
- pushes to `main` deploy `prd`
- PR deploys update the sticky PR comment
- `main` deploy successes post to Slack
- `main` deploy failures post to Slack
- workflow `paths` should include only the app folder and its contract folder unless there is a deliberate reason to widen them

Do not add preview logic back into `apps/<app>/scripts/router.ts` just to satisfy CI.

## Doppler

Use the `new-doppler-project` skill for the project/config setup.

The app package should work with:

```bash
doppler run --config stg -- pnpm alchemy:up
doppler run --config prd -- pnpm alchemy:up
```
