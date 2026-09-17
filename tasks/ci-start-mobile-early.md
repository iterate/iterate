# Start the mobile web server while preview CI prepares the backend

Status: implemented. Early startup, explicit reuse, logs, cleanup, and local checks are complete. Normal preview-CI timing and mobile-test proof remain.

Playwright currently starts Expo/Metro after the preview-ready wait on all six shards. In the reported run, Expo startup consumed about 12 seconds before test discovery. Start it earlier on the same runners so this work overlaps preview preparation.

- [x] Start Expo after dependency reconciliation and artifact reset, before waiting for the prepared preview. *The start_mobile_web step runs before browser reconciliation and the preview-ready wait.*
- [x] Reuse that server in Playwright with an explicit port and CI opt-in; preserve ordinary local startup. *The workflow passes PLAYWRIGHT_MOBILE_WEB_PORT=8081 and PLAYWRIGHT_MOBILE_WEB_PRESTARTED=1 to the config.*
- [x] Preserve startup logs and ensure the background process is cleaned up on success or failure. *A separate process group is stopped in an always step; server.log is printed and uploaded.*
- [x] Document selective startup as a follow-up, including Playwright's reverted per-project webServer support (https://github.com/microsoft/playwright/pull/41167). *The startup-step comment points to --list --shard selection and the upstream revert.*
- [ ] Run relevant checks and use normal preview CI to verify early startup, reuse, successful mobile tests, and the remaining time before the first test.

## Scope and assumptions

Start Expo on every shard. Do not change test selection, sharding, pnpm, runner images, backend deployment, or timeouts. Use the existing PLAYWRIGHT_MOBILE_WEB_PORT setting. Do not add real-pnpm tests; normal CI is the decisive performance check.

## Implementation log

- Baseline: workflow m9d6dlgz3c, shard 4/6, attempt g2f692gmzt; first test at +17.5s, Expo startup/readiness about 11.7s. The shard contained only desktop tests.
- Working branch: codex/ci-start-mobile-early, based on origin/main at 7c97a098d.

- Local install, typecheck, lint, knip, format, shell syntax, and 62 focused workflow/trace tests passed. The first all-workspace test run overlapped typecheck/lint and hit three subprocess timeouts; those 10 tests passed separately, then the full pnpm test passed without concurrent checks.
- First normal preview attempt (7jchf85xpl, c6c093df0): all six Metro starts passed (1.4–15.3s) and all six cleanup steps passed after Auth deployment failed before publishing preview-ready. Auth reported an undefined thrown error immediately after its JWKS smoke; a complete workflow rerun is in progress.
- Depot's whole-workflow rerun is intentionally rejected by the existing preview coordinator (`fresh workflow run, not a retry of an erased deployment`). Use a new pushed commit/fresh dispatch for subsequent experiments; do not loosen this guard.
