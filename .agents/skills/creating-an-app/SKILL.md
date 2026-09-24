---
name: creating-an-app
description: Add a new first-party app under apps/, which is a TanStack Start app on its own Worker and an OAuth client of the platform, like dash, agents, notes, voice and kit. Covers the envs.ts entry, Doppler project, per-PR previews and the prd deploy workflow. Use when someone asks for a new app, client or Worker.
---

# Creating an app

A first-party app is a TanStack Start app on its own Worker. It is an ordinary OAuth client of
the platform, with no secrets and no data of its own. `scripts/lib/start-app.ts` provides every
script and the Worker config, and the app only declares itself. Copy `apps/notes`, which is the
smallest one, and rename.

A plain Worker with no UI (such as `apps/dummy-petshop`) has a different shape. Copy that app
instead.

## 1. The app

Copy these files from `apps/notes`:

- `scripts/app.ts`: the app's `StartApp` (`name`, `root`, `envs`) plus the CLI line. `name` is
  the directory, the Doppler project and the local Worker name.
- `vite.config.ts`: the Cloudflare Vite plugin with
  `config: startAppWorkerConfig(<app>, process.env.CLOUDFLARE_ENV)`. There is no wrangler file
  (#2904).
- `package.json` scripts: `dev`, `build`, `typecheck` (which runs `routes:check`), `deploy`,
  `ensure-resources`, `routes:generate` and `routes:check`. All of them run `tsx scripts/app.ts …`
  or `vite`.
- `src/server.ts`: `/healthz` (the deploy smoke hits it), the `/e/` PostHog proxy, `appAuth`
  with the app's `client` name and logo, and `export { BrowserSession }`.
- `src/router.tsx`, `src/routes/__root.tsx`, and `src/routes/_auth.tsx`, which is `ssr: false`
  with `createIterateClient({ scopes })` in `beforeLoad`.
- `public/client-logo.svg`, the logo the consent page shows, and `tsconfig.json`, which extends
  `tsconfig.base.json`.

Then run `pnpm install` and `pnpm --dir apps/<app> routes:generate`.

## 2. Register it

| File                                                                   | Change                                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envs.ts`                                                              | `<app>Envs` with `preview` (the per-PR parent: dev/preview account, `<app>-preview` on `iterate-dev-preview.workers.dev`) and `prd` (with `posthogProjectKey`) |
| `scripts/lib/start-app.ts`                                             | `FIRST_PARTY_APPS`, which drives the deny zones and `ITERATE_APP_ORIGINS`                                                                                      |
| `apps/os/scripts/preview-config.ts`                                    | `APPS`, so each PR previews it next to the platform and it gets its own `Sign in ↗` link                                                                       |
| `pnpm-workspace.yaml`, `knip.ts`, `doppler.yaml`                       | the workspace entry, the `apps/{dash,kit,notes,voice}` knip block, `project: <app>` with `path: apps/<app>/`                                                   |
| `scripts/ci/preview-paths.ts`, `preview-delete.yml`, `main-os-e2e.yml` | `apps/<app>/**` and `deploy-<app>.yml` in `previewPaths` and both workflows' `paths`, and the app list in `preview-os.yml`'s `apps` description                |
| `apps/dash/src/apps.ts`                                                | only if the app opens a project: the dash's directory, keyed by the same name                                                                                  |
| `envs.ts` `osEnvs.prd.projectWildcard.excludedHostnames`               | only for a custom domain under `iterate.com`                                                                                                                   |

The parent `<app>-preview` Worker does not need to exist in advance. The first preview deploy
creates it from the same config.

## 3. Doppler and the prd deploy

Read [Doppler setup](references/doppler.md). Then copy `.depot/workflows/deploy-dash.yml` to
`deploy-<app>.yml`, and change the name, the concurrency group, the `paths` (the app's
directory and the workflow itself), the Doppler project, the `working-directory`, and
`APP_DISPLAY_NAME`/`PUBLIC_URL`. Depot registers triggers from the default branch, so the
workflow first runs after it lands on `main` ([Depot CI](../../../docs/depot-ci.md)).

A workers.dev `baseUrl` needs nothing else. A custom domain needs its zone in the prd account,
plus `pnpm --dir apps/<app> ensure-resources --env prd` once for the proxied DNS record.

## 4. Prove it

- `pnpm typecheck`, `pnpm lint`, `pnpm knip`, `pnpm format`.
- Locally: `pnpm dev` for the platform, plus `ITERATE_ORIGIN=http://localhost:8788` in the
  app's gitignored `.dev.vars`, then `pnpm --dir apps/<app> dev`.
- On the PR: the Preview OS workflow deploys the app next to the platform. Open its `Sign in ↗`
  link in an isolated browser session and check that it lands signed in inside project `pr<n>`.
- Browser specs go under `specs/<app>/`, with a Playwright project in `playwright.config.ts`
  and a base URL that `runSuite` (`apps/os/scripts/preview.ts`) passes. Notes is the example.
