---
name: creating-an-app
description: Add a new first-party app under apps/, which is a TanStack Start app on its own Worker and an OAuth client of the platform, like the other clients in apps/. Covers the envs.ts entry, Doppler project, per-PR previews and the prd deploy workflow. Use when someone asks for a new app, client or Worker.
---

# Creating an app

A first-party app is a TanStack Start app on its own Worker. It is an ordinary OAuth client of
the platform, with no secrets and no data of its own. `scripts/lib/start-app.ts` provides every
script and the Worker config, and the app only declares itself. Copy `apps/voice`, a small one that
opens a project, and rename. (Notes has no sign-in of its own: a project's config worker serves it.)

A plain Worker with no UI (such as `apps/dummy-petshop`) has a different shape. Copy that app
instead.

## 1. The app

Copy `scripts/app.ts` and `src/routes/` from `apps/voice`:

- `scripts/app.ts`: the app's `StartApp` (`name`, `root`, `envs`, `dopplerProject`) plus the CLI
  line. `name` is the directory and the local Worker name; `dopplerProject` is `"_shared"` unless
  the app has secrets of its own ([Doppler setup](references/doppler.md)).
- `src/routes/`: `__root.tsx` (`AppDocument`), the landing page `index.tsx`, and `_auth.tsx`, which
  is `ssr: false` with `createIterateClient({ scopes })` in `beforeLoad`. An app a project proxies
  under paths ingress needs Notes' `basePath` too (`apps/notes/src/base-path.ts`).

The rest is the shared shell called with the app's own values: `vite.config.ts` is
`startAppVitePlugins` (`scripts/lib/start-app-vite.ts`; there is no wrangler file, iterate/iterate#2904),
`src/server.ts` is `appServerEntry` (`@iterate-com/ui/apps/server`: `/healthz`, which the deploy
smoke hits, the PostHog proxy and the sign-in gate under the app's `clientName`) and
`export { BrowserSession }`, and `src/router.tsx` is `createAppRouter`. Add the `package.json`
scripts (`dev`, `build`, `typecheck`, which runs `routes:check`, `deploy`, `ensure-resources`,
`routes:generate` and `routes:check`), `public/client-logo.svg`, the logo the consent page shows,
and a `tsconfig.json` that extends `tsconfig.app.json`.

Then run `pnpm install` and `pnpm --dir apps/<app> routes:generate`.

## 2. Register it

| File                                                                                          | Change                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envs.ts`                                                                                     | `<app>Envs` with `preview` (main on dev: dev/preview account, `<app>` on `iterate-dev-preview.workers.dev`) and `prd` (with `posthogProjectKey`); `PREVIEW_DEPLOYMENT_APPS`, so each PR deploys it |
| `scripts/lib/start-app.ts`                                                                    | `FIRST_PARTY_APPS`, which drives the deny zones and the apps' `APP_CONFIG` `urls`                                                                                                                  |
| `packages/shared/src/start-app-config.ts`                                                     | the app's name under `urls`, which `FIRST_PARTY_APPS` is typed against                                                                                                                             |
| `scripts/os/preview-config.ts`                                                                | `APPS`, so each PR deploys it next to the platform and it gets its own `Sign in ↗` link                                                                                                            |
| `pnpm-workspace.yaml`, `knip.ts`, `doppler.yaml`                                              | the workspace entry, the `apps/{dash,notes,voice}` knip block, `project: <app>` with `path: apps/<app>/`                                                                                           |
| `scripts/ci/preview-paths.ts`, `preview-delete.yml`, `main-os-e2e.yml`, `preview-parents.yml` | `apps/<app>/**` and `deploy-<app>.yml` in `previewPaths` and the three workflows' `paths`, and the app list in `preview-os.yml`'s `apps` description                                               |
| `apps/dash/src/apps.ts`                                                                       | only if the app opens a project: the dash's directory, keyed by the same name                                                                                                                      |
| `envs.ts` `osEnvs.prd.projectWildcard.excludedHostnames`                                      | only for a custom domain under `iterate.com`                                                                                                                                                       |

A PR deploys the app as `pr<n>-<sha7>-<app>` beside the platform with no setup: nothing on the
dev/preview account needs to exist first. Main on dev's `<app>` worker is deployed by the Preview
parents workflow once the app is on `main`.

## 3. Doppler and the prd deploy

Read [Doppler setup](references/doppler.md). Then copy `.depot/workflows/deploy-dash.yml` to
`deploy-<app>.yml`, and change the name, the concurrency group, the `paths` (the app's
directory and the workflow itself), the `working-directory`, and
`APP_DISPLAY_NAME`. Depot registers triggers from the default branch, so the
workflow first runs after it lands on `main` ([Depot CI](../../../docs/depot-ci.md)).

A workers.dev `baseUrl` needs nothing else. A custom domain needs its zone in the prd account,
plus `pnpm --dir apps/<app> ensure-resources --env prd` once for the proxied DNS record.

## 4. Prove it

- `pnpm typecheck`, `pnpm lint`, `pnpm knip`, `pnpm format`.
- Locally: `pnpm dev` for the platform, plus `APP_CONFIG_URLS__OS=http://localhost:8788` in the
  app's gitignored `.dev.vars`, then `pnpm --dir apps/<app> dev`.
- On the PR: the Preview OS workflow deploys the app next to the platform. Open its `Sign in ↗`
  link in an isolated browser session, sign in to the preview as `admin@preview.iterate.test`
  with its password, confirm **Sign in as someone else**, and check that the app lands inside
  project `pr<n>`.
- Browser specs go under `test/playwright/<app>/`, with a Playwright project in `test/playwright.config.ts`
  and a base URL that `runSuite` (`scripts/os/preview.ts`) passes. Voice is the example.
