---
status: complete
size: medium
branch: codex/os-local-playwright-e2e-main
base: main
---

# OS Local Playwright E2E

Status summary: Complete, recreated against `main` after PR 1545 was accidentally based on `codex/project-worker-ts-entrypoint`. The repo now has root-level product specs in `specs/` with a localhost-only Playwright lane that starts local auth and OS through `webServer`, discovers the OS dev port from `.alchemy/dev-server.json`, signs in through local auth, and creates a project. Focused static/unit checks and the full local Playwright run are green.

## Assumptions

- This is recreated directly on `main`; the original PR 1545 branch was stacked on top of `codex/project-worker-ts-entrypoint`.
- The lane is localhost-only and should use `pnpm dev:local` or equivalent local OS dev startup, not Doppler tunnel configs, webhooks, or deployed preview/prod URLs.
- Playwright should discover the actual selected localhost port through the existing `.alchemy/dev-server.json` mechanism instead of hardcoding a Vite port or scraping logs.
- Use the published npm package `middlewright` and keep `actionTimeout` aggressively low.
- Follow q1’s helper balance: helpers for common actions like login and project creation; no helper wrappers for one-off assertions.

## Checklist

- [x] Add a root Playwright config with `webServer` startup and localhost base URL discovery. _Implemented in `playwright.config.ts`; `specs/start-local-dev.ts` starts local auth/OS and waits on a ready endpoint backed by `.alchemy/dev-server.json`._
- [x] Add middlewright-backed Playwright fixture wiring with aggressive action timeouts. _Implemented in `specs/test-support/test.ts` using `middlewright` with a 750ms normal action timeout._
- [x] Add a minimal dashboard flow spec that logs in and creates a project. _Implemented in `specs/dashboard.spec.ts`; the helper signs in through local auth OTP and the test creates a project._
- [x] Add package scripts/dependencies needed to run the Playwright lane from the repo root. _Added `pnpm spec`, Playwright/middlewright, and root workspace support deps for auth/shared helpers in `package.json`/`pnpm-lock.yaml`._
- [x] Run and document verification for the new Playwright lane plus relevant static checks. _Verified Playwright discovery, local auth bootstrap unit coverage, OS typecheck, root lint, and the full local Playwright run._

## Implementation Notes

- q1 reference checked before implementation: root `playwright.config.ts`, `spec/test-helpers.ts`, and the login/org/project specs.
- Current OS dev startup writes `.alchemy/dev-server.json`; `specs/test-support/local-dev.ts` now uses the shared reader directly from root-level product specs.
- The first implementation used forged auth URLs, but the final lane now starts `apps/auth` locally and drives the real local auth email OTP/OAuth flow with seeded local auth data.
- The local `../middlewright` checkout was used to inspect the API, but the committed dependency is the published `middlewright@^0.1.0`; CI cannot install from a sibling checkout path.
- `apps/os/src/auth/dev-oauth-client-bootstrap.ts` now treats underscore `dev_*` Alchemy stages as local OAuth sync targets, so `dev:local` can register the OS OAuth client correctly.
- `apps/os/src/routes/_app/projects/index.tsx` uses `nativeButton={false}` for Base UI buttons rendered as TanStack links, removing the invalid nested-button warning surfaced by Playwright.
- The recreated main-based branch runs local auth and OS under `dev_playwright`; plain shared `dev` does not give OS a concrete `dev_*` OAuth client bootstrap target.
- `apps/auth/src/routes/login.tsx` exposes a hydration/loading marker for the email login button so middlewright waits for the real clickable button instead of racing a pre-hydration disabled control.
- `apps/os/src/routes/_app/projects/index.tsx` exposes a small pending state so the dashboard route is not a blank outlet while server-function data loads.
- Verification run:
  - `pnpm install --frozen-lockfile`
  - `OS_PLAYWRIGHT_BASE_URL=http://localhost:1 pnpm exec playwright test --config playwright.config.ts --list`
  - `pnpm knip`
  - `pnpm --dir apps/os exec vitest run src/auth/dev-oauth-client-bootstrap.test.ts`
  - `pnpm --dir apps/os typecheck`
  - `pnpm --dir apps/auth typecheck`
  - `pnpm lint`
  - `pnpm format:check`
  - `pnpm spec`
