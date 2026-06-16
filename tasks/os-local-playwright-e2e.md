---
status: in-progress
size: medium
branch: codex/os-local-playwright-e2e
base: codex/project-worker-ts-entrypoint
---

# OS Local Playwright E2E

Status summary: Spec written; implementation not started yet. The goal is a minimal localhost-only Playwright lane for `apps/os` that starts local dev through Playwright `webServer`, logs into the dashboard, and creates a project. Missing pieces are the Playwright config, middlewright fixture wiring, dashboard/project spec, package scripts/dependencies, and verification.

## Assumptions

- This is stacked on top of `codex/project-worker-ts-entrypoint`, not `main`.
- The lane is localhost-only and should use `pnpm dev:local` or equivalent local OS dev startup, not Doppler tunnel configs, webhooks, or deployed preview/prod URLs.
- Playwright should discover the actual selected localhost port through the existing `.alchemy/dev-server.json` mechanism instead of hardcoding a Vite port or scraping logs.
- Use the npm package `middlewright` from the local checkout at `../middlewright` and keep `actionTimeout` aggressively low.
- Follow q1’s helper balance: helpers for common actions like login and project creation; no helper wrappers for one-off assertions.

## Checklist

- [ ] Add an `apps/os` Playwright config with `webServer` startup and localhost base URL discovery.
- [ ] Add middlewright-backed Playwright fixture wiring with aggressive action timeouts.
- [ ] Add a minimal dashboard flow spec that logs in and creates a project.
- [ ] Add package scripts/dependencies needed to run the Playwright lane from `apps/os`.
- [ ] Run and document verification for the new Playwright lane plus relevant static checks.

## Implementation Notes

- q1 reference checked before implementation: root `playwright.config.ts`, `spec/test-helpers.ts`, and the login/org/project specs.
- Current OS dev startup writes `.alchemy/dev-server.json`; `apps/os/e2e/test-support/dev-server.ts` already wraps that reader for Vitest e2e.
