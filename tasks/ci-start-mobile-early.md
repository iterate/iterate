# Start the mobile web server while preview CI prepares the backend

Status: planned. The startup delay is measured; implementation and normal-CI proof remain.

Playwright currently starts Expo/Metro after the preview-ready wait on all six shards. In the reported run, Expo startup consumed about 12 seconds before test discovery. Start it earlier on the same runners so this work overlaps preview preparation.

- [ ] Start Expo after dependency reconciliation and artifact reset, before waiting for the prepared preview.
- [ ] Reuse that server in Playwright with an explicit port and CI opt-in; preserve ordinary local startup.
- [ ] Preserve startup logs and ensure the background process is cleaned up on success or failure.
- [ ] Document selective startup as a follow-up, including Playwright's reverted per-project webServer support (https://github.com/microsoft/playwright/pull/41167).
- [ ] Run relevant checks and use normal preview CI to verify early startup, reuse, successful mobile tests, and the remaining time before the first test.

## Scope and assumptions

Start Expo on every shard. Do not change test selection, sharding, pnpm, runner images, backend deployment, or timeouts. Use the existing PLAYWRIGHT_MOBILE_WEB_PORT setting. Do not add real-pnpm tests; normal CI is the decisive performance check.

## Implementation log

- Baseline: workflow m9d6dlgz3c, shard 4/6, attempt g2f692gmzt; first test at +17.5s, Expo startup/readiness about 11.7s. The shard contained only desktop tests.
- Working branch: codex/ci-start-mobile-early, based on origin/main at 7c97a098d.
