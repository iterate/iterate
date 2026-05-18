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

1. Add a new-style app to `packages/shared/src/apps/new-style-cloudflare-apps.ts`.
2. If it participates in PR previews, add preview test metadata in `scripts/preview/apps.ts`.
3. Add a thin workflow entry in `.github/ts-workflows/workflows/deploy-<app>.ts`.
4. Regenerate YAML with `pnpm -C .github/ts-workflows generate`.

The shared app manifest is the source of truth for:

- app slug
- display name
- repo path
- Doppler project
- path filters
- temporary deploy dependencies

The preview registry adds:

- preview test base URL env var
- preview test command

Preview deploys do not live in app-local routers anymore. They run through the repo preview router:

```bash
doppler run --project _shared --config prd -- pnpm preview sync --pull-request-number 1234
doppler run --project _shared --config prd -- pnpm preview cleanup --pull-request-number 1234
```

Workflow rules:

- PR pushes deploy a leased `preview_N`
- pushes to `main` deploy `prd`
- PR deploys update the managed preview section in the PR body
- `main` deploy successes post to Slack
- `main` deploy failures post to Slack
- new-style workflow `paths` include the app folder, contract folder, and shared new-style deploy paths from `packages/shared/src/apps/new-style-cloudflare-apps.ts`

Do not add preview logic back into `apps/<app>/scripts/router.ts` just to satisfy CI.

## Doppler

Use the `new-doppler-project` skill for the project/config setup.

The app package should work with:

```bash
doppler run --project <app> --config preview_2 -- pnpm exec tsx ./alchemy.run.ts
doppler run --project <app> --config prd -- pnpm exec tsx ./alchemy.run.ts
```
