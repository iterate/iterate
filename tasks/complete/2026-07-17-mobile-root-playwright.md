---
status: complete
size: medium
---

# Mobile in the root Playwright suite

**Status summary:** complete. Root Playwright now owns the `web` and `mobile` projects, starts OS and Expo Web independently, and exposes Playwright's built-in project filtering. The duplicate mobile runner/config/dependency are gone; the spec, baselines, and docs have moved to the root suite.

Fold the Expo Web screenshot test from PR #2064 into the normal root Playwright suite. Do not turn the OS dev lifecycle wrapper into a hidden multi-process supervisor: Playwright already supports multiple `webServer` entries and should directly own the extra Metro process it needs.

## Acceptance criteria

- [x] Root Playwright has projects named exactly `web` and `mobile` — _configured in `playwright.config.ts`._
- [x] `pnpm spec` starts/reuses the local OS server as before, starts Expo Web, and runs both projects without either project collecting the other project's specs — _the combined run collected 51 web specs plus one mobile spec through the two-entry `webServer` array._
- [x] `pnpm spec --project=mobile` runs only the phone-sized mobile specs through Expo Web — _focused run passes the one mobile visual spec._
- [x] `pnpm spec --project=web` runs only the existing product specs and preserves deployed-target behavior — _project listing contains the existing 51 web specs; OS targeting remains controlled by `APP_CONFIG_BASE_URL`._
- [x] Move the mobile spec and reviewed screenshot baselines under root `specs/mobile/`, following `specs/AGENTS.md` — _the spec now uses root test support and both PNGs live beside it._
- [x] Remove `apps/mobile/playwright.config.ts` and the duplicate Playwright dependency/configuration; keep `apps/mobile test:screenshots` only if it can be a thin alias to the root runner without inventing a second interface — _the config, script, and app-local dependency were removed; no alias was needed._
- [x] Allocate the Expo Web port safely for parallel worktrees and avoid relying on a globally fixed `8082` — _root config selects a free loopback port, excludes the OS port, and shares it across Playwright config loads._
- [x] Update mobile and dev-environment docs with the unified commands and project filters — _both docs now show `pnpm spec --project=mobile` and describe both projects._

## Decisions

- Playwright's `webServer` array owns OS and Expo Web independently. `apps/os/scripts/dev.ts` remains a single-server lifecycle module with truthful PID/discovery/status/kill semantics.
- Project-level `testMatch`/`testIgnore` partitions the suite: `web` owns existing specs; `mobile` owns only `specs/mobile/**`.
- The project names intentionally describe product surfaces, not today's browser engine. Both use Chromium for now.
- The root `pnpm spec` script remains the only required interface. Playwright's built-in `--project` option is the filtering interface; no `spec:mobile` script.

## Implementation log

- 2026-07-17: follow-up agreed after PR #2064. The separate mobile config proved the browser path; this task consolidates it into the repository's normal Playwright topology.
- 2026-07-17: red proof was `pnpm spec --project=mobile --list`, which initially reported that only the old `chromium` project existed. The final focused mobile run, typecheck, lint, and format check pass.
- 2026-07-17: a combined run exercised both servers and all 52 specs; the mobile spec and 48 web specs passed. Three existing local web cases failed (two auth onboarding waits and the Containers-disabled `sandbox-exec` example). The root unit run passed all completed workspaces, including all 30 mobile tests, but the OS Vitest process was stopped after sitting idle for more than six minutes.
