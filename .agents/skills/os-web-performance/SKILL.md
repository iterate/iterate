---
name: os-web-performance
description: Diagnose and improve loading speed of the platform's pages (apps/os sign-in and consent) and the TanStack Start clients, including Core Web Vitals, asset caching, bundle waterfalls, hydration, and the first live-state read. Use when an app feels slow, a route shows a spinner for too long, a warm visit re-downloads or revalidates assets, or a performance PR needs evidence from a deployment.
---

# Web performance

Make the apps feel immediate without hiding latency, errors, or state divergence.

## Targets (p75, desktop and mobile)

| Metric |    Target |
| ------ | --------: |
| TTFB   | <= 400 ms |
| FCP    |  <= 1.0 s |
| LCP    |  <= 1.8 s |
| INP    | <= 100 ms |
| CLS    |   <= 0.03 |

A warm visit should transfer zero asset bytes and make zero revalidation round trips for
fingerprinted `/assets/*`.

## Know the shape before measuring

- **The platform's pages.** `/`, `/login` and the `/oauth2/auth` consent are server-rendered
  TanStack Start routes in `apps/os/src/routes/`, served by the platform Worker.
- **The clients.** Each client is its own Worker (`scripts/lib/start-app.ts`). Its signed-in
  layout (`src/routes/_auth.tsx`) is `ssr: false`, because the browser authenticates through
  `createIterateClient`. The HTML is the pending shell, and every page's data comes over the
  app origin's `/api` capnweb WebSocket (`useLiveState` and friends in `iterate/react`).
  Most time-to-content is therefore JS graph, then auth, then socket, then the first read.
- **Assets.** Each app serves assets from `env.ASSETS` in `src/server.ts`. Check the headers
  a real deployment sends before you assume they are cached (see the playbook).

## Workflow

1. Read [the playbook](references/playbook.md) and classify the delay: document, asset cache,
   JS graph, auth, socket and first read, live fan-out, or an optional heavy runtime. For
   route, loader, split or hydration work, also read [TanStack Start](references/tanstack-start.md).
2. Measure on the PR's own preview, never only on local dev. The PR body lists every app's
   preview URL (`appPreviewUrl` in `apps/os/scripts/preview-config.ts`) with a one-click
   `Sign in ↗` link. The link signs a fresh browser in as `pr<n>@preview.iterate.test` and
   lands in project `pr<n>`, once prd confirms the browser is an `*@nustom.com` person's; an
   isolated session has no such prd sign-in, so sign in with the preview's password (Doppler
   `os/preview`, `APP_CONFIG` `login.password`) instead. Use an isolated Playwriter session
   ([browser testing](../../../docs/browser-testing.md)), never the developer's own Chrome.
   Record cold, warm, and in-app navigation on the same route, with
   [the evidence the playbook lists](references/playbook.md#measure-what-people-get).
   Measure `main` the same way for the "before".
3. Field data is prd only (previews carry no PostHog key, per `envs.ts`). Follow the PostHog
   instructions in your agent config, confirm that web-vitals events exist for the app before
   quoting p75s, and split them by route, device, and release.
4. Inspect the production graph with `pnpm --dir apps/<app> exec vite build --manifest`, which
   writes `dist/client/.vite/manifest.json`. Count modulepreloads, bytes, and requests before
   FCP/LCP.
5. Write a red user-facing test (`specs/`), make the narrowest change, prove the package tests,
   typecheck, lint and build, then repeat the same captures on the preview.
6. Read the preview window's Workers Logs for the app's worker and the platform's
   (debug-os-worker skill). Explain every new warning or error.

## Report

Include the app, route, preview URL and commit, browser and viewport, cache state, UTC window;
cold, warm and in-app TTFB/FCP/LCP/INP/CLS, bytes and request counts before and after; asset
cache headers; the graph change; the tests; and any remaining gap to the targets.

Read [tooling](references/tooling.md) before adding a third-party performance skill, scanner or
CI gate.
