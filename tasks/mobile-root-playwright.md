---
status: ready
size: medium
---

# Mobile in the root Playwright suite

**Status summary:** specified and ready to implement. The mobile browser spec currently owns a second Playwright configuration and command; this follow-up will make root `pnpm spec` the single public test runner for both web and mobile, while preserving Playwright-managed server lifecycles and project filtering.

Fold the Expo Web screenshot test from PR #2064 into the normal root Playwright suite. Do not turn the OS dev lifecycle wrapper into a hidden multi-process supervisor: Playwright already supports multiple `webServer` entries and should directly own the extra Metro process it needs.

## Acceptance criteria

- [ ] Root Playwright has projects named exactly `web` and `mobile` — _pending_
- [ ] `pnpm spec` starts/reuses the local OS server as before, starts Expo Web, and runs both projects without either project collecting the other project's specs — _pending_
- [ ] `pnpm spec --project=mobile` runs only the phone-sized mobile specs through Expo Web — _pending_
- [ ] `pnpm spec --project=web` runs only the existing product specs and preserves deployed-target behavior — _pending_
- [ ] Move the mobile spec and reviewed screenshot baselines under root `specs/mobile/`, following `specs/AGENTS.md` — _pending_
- [ ] Remove `apps/mobile/playwright.config.ts` and the duplicate Playwright dependency/configuration; keep `apps/mobile test:screenshots` only if it can be a thin alias to the root runner without inventing a second interface — _pending_
- [ ] Allocate the Expo Web port safely for parallel worktrees and avoid relying on a globally fixed `8082` — _pending_
- [ ] Update mobile and dev-environment docs with the unified commands and project filters — _pending_

## Decisions

- Playwright's `webServer` array owns OS and Expo Web independently. `apps/os/scripts/dev.ts` remains a single-server lifecycle module with truthful PID/discovery/status/kill semantics.
- Project-level `testMatch`/`testIgnore` partitions the suite: `web` owns existing specs; `mobile` owns only `specs/mobile/**`.
- The project names intentionally describe product surfaces, not today's browser engine. Both use Chromium for now.
- The root `pnpm spec` script remains the only required interface. Playwright's built-in `--project` option is the filtering interface; no `spec:mobile` script.

## Implementation log

- 2026-07-17: follow-up agreed after PR #2064. The separate mobile config proved the browser path; this task consolidates it into the repository's normal Playwright topology.
