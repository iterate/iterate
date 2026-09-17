# Start the mobile web server while preview CI prepares the backend

Status: complete. Early startup, explicit reuse, logs, and cleanup passed normal preview CI on all six shards. First non-skipped tests now start in 5.1–6.5s; mobile tests passed, with one signup retry.

Playwright currently starts Expo/Metro after the preview-ready wait on all six shards. In the reported run, Expo startup consumed about 12 seconds before test discovery. Start it earlier on the same runners so this work overlaps preview preparation.

- [x] Start Expo after dependency reconciliation and artifact reset, before waiting for the prepared preview. *The start_mobile_web step runs before browser reconciliation and the preview-ready wait.*
- [x] Reuse that server in Playwright with an explicit port and CI opt-in; preserve ordinary local startup. *The workflow passes PLAYWRIGHT_MOBILE_WEB_PORT=8081 and PLAYWRIGHT_MOBILE_WEB_PRESTARTED=1 to the config.*
- [x] Preserve startup logs and ensure the background process is cleaned up on success or failure. *A separate process group is stopped in an always step; server.log is printed and uploaded.*
- [x] Document selective startup as a follow-up, including Playwright's reverted per-project webServer support (https://github.com/microsoft/playwright/pull/41167). *The startup-step comment points to --list --shard selection and the upstream revert.*
- [x] Run relevant checks and use normal preview CI to verify early startup, reuse, successful mobile tests, and the remaining time before the first test. *All local checks and workflow n9ck0nn83t passed; one Expo launch and successful cleanup per shard.*

## Scope and assumptions

Start Expo on every shard. Do not change test selection, sharding, pnpm, runner images, backend deployment, or timeouts. Use the existing PLAYWRIGHT_MOBILE_WEB_PORT setting. Do not add real-pnpm tests; normal CI is the decisive performance check.

## Implementation log

- Baseline: workflow m9d6dlgz3c, shard 4/6, attempt g2f692gmzt; first test at +17.5s, Expo startup/readiness about 11.7s. The shard contained only desktop tests.
- Working branch: codex/ci-start-mobile-early, based on origin/main at 7c97a098d.

- Local install, typecheck, lint, knip, format, shell syntax, and 62 focused workflow/trace tests passed. The first all-workspace test run overlapped typecheck/lint and hit three subprocess timeouts; those 10 tests passed separately, then the full pnpm test passed without concurrent checks.
- First normal preview attempt (7jchf85xpl, c6c093df0): all six Metro starts passed (1.4–15.3s) and all six cleanup steps passed after Auth deployment failed before publishing preview-ready. Auth reported an undefined thrown error immediately after its JWKS smoke; a complete workflow rerun is in progress.
- Depot's whole-workflow rerun is intentionally rejected by the existing preview coordinator (`fresh workflow run, not a retry of an erased deployment`). Use a new pushed commit/fresh dispatch for subsequent experiments; do not loosen this guard.

- Successful normal CI on 2c5fd6f48: https://depot.dev/orgs/0p91s0lz49/workflows/n9ck0nn83t. All six Playwright jobs and the complete preview workflow passed. Early Metro readiness took 1.8–16.7s, followed by 172–207s of preview wait. Logs show exactly one Expo launch per runner and successful cleanup.
- Time from the Playwright step to its first non-skipped test, shards 1–6: 5.141s, 6.123s, 5.649s, 6.490s, 5.345s, 5.247s (median 5.497s). Recent main 7c97a098d: 19.922s, 6.945s, 7.989s, 19.087s, 17.503s, 8.845s (median 13.174s).
- Mobile outcomes: 15 passed, one existing expected failure, one existing skip. The approvals test passed on its normal retry after a signup form Organization name field timeout. No test behavior or retry budget changed.
