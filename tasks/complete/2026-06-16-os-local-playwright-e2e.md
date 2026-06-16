---
status: complete
size: medium
branch: codex/os-local-playwright-e2e
base: codex/project-worker-ts-entrypoint
---

# OS Local Playwright E2E

Status summary: Complete. `apps/os` now has a localhost-only Playwright lane that starts local auth and OS through `webServer`, discovers the OS dev port from `.alchemy/dev-server.json`, signs in through local auth, and creates a project. Focused unit/static checks and the full Playwright flow are green.

## Assumptions

- This is stacked on top of `codex/project-worker-ts-entrypoint`, not `main`.
- The lane is localhost-only and should use `pnpm dev:local` or equivalent local OS dev startup, not Doppler tunnel configs, webhooks, or deployed preview/prod URLs.
- Playwright should discover the actual selected localhost port through the existing `.alchemy/dev-server.json` mechanism instead of hardcoding a Vite port or scraping logs.
- Use the npm package `middlewright` from the local checkout at `../middlewright` and keep `actionTimeout` aggressively low.
- Follow q1’s helper balance: helpers for common actions like login and project creation; no helper wrappers for one-off assertions.

## Checklist

- [x] Add an `apps/os` Playwright config with `webServer` startup and localhost base URL discovery. _Implemented in `apps/os/playwright.config.ts`; `start-local-dev.ts` starts local auth/OS and waits on a ready endpoint backed by `.alchemy/dev-server.json`._
- [x] Add middlewright-backed Playwright fixture wiring with aggressive action timeouts. _Implemented in `apps/os/e2e/playwright/test-support/test.ts` using `middlewright` with a 750ms normal action timeout._
- [x] Add a minimal dashboard flow spec that logs in and creates a project. _Implemented in `apps/os/e2e/playwright/dashboard.spec.ts`; the helper signs in through local auth OTP and the test creates a project._
- [x] Add package scripts/dependencies needed to run the Playwright lane from `apps/os`. _Added `e2e:playwright`, `@playwright/test`, `playwright`, and local `middlewright` wiring in `apps/os/package.json`/`pnpm-lock.yaml`._
- [x] Run and document verification for the new Playwright lane plus relevant static checks. _Verified Playwright discovery, local auth bootstrap unit coverage, OS typecheck, root lint, and the full local Playwright run._

## Implementation Notes

- q1 reference checked before implementation: root `playwright.config.ts`, `spec/test-helpers.ts`, and the login/org/project specs.
- Current OS dev startup writes `.alchemy/dev-server.json`; `apps/os/e2e/test-support/dev-server.ts` already wraps that reader for Vitest e2e.
- The first implementation used forged auth URLs, but the final lane now starts `apps/auth` locally and drives the real local auth email OTP/OAuth flow with seeded local auth data.
- `apps/os/src/auth/dev-oauth-client-bootstrap.ts` now treats underscore `dev_*` Alchemy stages as local OAuth sync targets, so `dev:local` can register the OS OAuth client correctly.
- `apps/os/src/routes/_app/projects/index.tsx` uses `nativeButton={false}` for Base UI buttons rendered as TanStack links, removing the invalid nested-button warning surfaced by Playwright.
- Verification run:
  - `pnpm --dir apps/os exec vitest run src/auth/dev-oauth-client-bootstrap.test.ts`
  - `OS_PLAYWRIGHT_BASE_URL=http://localhost:1 pnpm --dir apps/os exec playwright test --config playwright.config.ts --list`
  - `pnpm --dir apps/os typecheck`
  - `pnpm lint`
  - `pnpm --dir apps/os e2e:playwright`
