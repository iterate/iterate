# Testing: Unit, E2E, And Playwright Specs

How the test lanes are organized, how to run each against any environment,
the canonical environment variables, and [the retry/timeout
policy](#retries-and-timeouts) every lane follows. For unit-test style (fake
timers, inline snapshots, `test.for` tables), see
[Vitest patterns](vitest-patterns.md).

## Lanes

| Lane             | Command (from `apps/os` unless noted) | Lives in                                | Proves                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `pnpm test`                           | `apps/os/src/**/*.test.ts` (colocated)  | In-process logic; no deployment needed.                                                                                                                                                                                                                                                                                                                                                                                   |
| OS e2e           | `pnpm e2e`                            | `apps/os/e2e/` (`e2e/vitest.config.ts`) | One config, two projects against a live deployment through the itx surface. `--project node`: engine e2e (`e2e/vitest/` — streams, security, ingress, agents, admin, preview smoke) plus the itx catalogue matrix (`e2e/examples/` — every example across five runtimes: browser, node, cli, run-script, project-worker). `--project browser` runs the catalogue in a real browser (needs a Playwright chromium install). |
| TUI              | `pnpm exec tsx e2e/tui-test/run.ts`   | `apps/os/e2e/tui-test/`                 | The `iterate chat` TUI through a real PTY (Microsoft TUI Test) against a disposable project.                                                                                                                                                                                                                                                                                                                              |
| Playwright specs | `pnpm spec` (repo root)               | `specs/` (`playwright.config.ts`)       | Browser-level product flows: signup, project create, dashboard, REPL, agent chat, reactivity.                                                                                                                                                                                                                                                                                                                             |

## Running a lane against an environment

Every non-unit lane targets a live deployment and is invoked the same way:

```bash
doppler run --config <cfg> -- pnpm <lane>
```

The Doppler config supplies the deployment identity — `APP_CONFIG_BASE_URL`
and `APP_CONFIG_ADMIN_API_SECRET` (plus optional integration secrets):

```bash
# local dev (start `pnpm dev` first; base URL comes from the discovery file)
doppler run --config dev -- pnpm e2e

# a preview slot
doppler run --config preview_3 -- pnpm e2e

# production
doppler run --config prd -- pnpm e2e
```

Local configs (`dev`, `dev_<you>`) do not set `APP_CONFIG_BASE_URL`; the
harness falls back to the dev-server discovery file
(`apps/os/.dev-server/dev-server.json`, written by `pnpm dev`). To point a lane at
a custom target (captun, another port), set the base URL explicitly _inside_
the Doppler environment:

```bash
doppler run --config dev -- env APP_CONFIG_BASE_URL=http://localhost:1234 pnpm e2e
```

## Using Tunnels In Tests

Use [Iterate tunnels](tunnels.md) when a test target cannot reach the test
runner directly. The common case is a deployed preview Worker calling an e2e
fixture: `127.0.0.1` belongs to the Worker runtime, not the CI runner, so the
fixture must be published at a public HTTPS URL.

Tunnel-backed tests should run inside Doppler so `CAPTUN_TOKEN` is available:

```bash
doppler run --project os --config dev -- pnpm e2e
```

OS e2e fixtures should use `withTunnel()` from
`apps/os/e2e/test-support/tunnel.ts`. It returns a loopback URL for local dev
targets and a captun URL when `APP_CONFIG_BASE_URL` points at a deployed
worker. Lower-level scripts can use
`createCaptunTunnel({ fetch, token, gateway })` from `captun`.

Omit `name` for isolated test fixtures; pass `name` only when a stable
callback URL is required:

```text
https://<name>.tunnels.iterate.com
```

The gateway forwards HTTP and WebSockets. That makes it suitable for webhook
receivers, OAuth callbacks, local dev server access, and e2e fixtures that need
streaming or WebSocket behavior.

## Environment variables

The rule: **one name per control, and no variable without a real setter**.
`APP_CONFIG_*` variables come from the Doppler config and describe the
deployment under test — tests never invent parallel names for them. The two
`OS_E2E_TUI_*` variables and `E2E_RETRY_TELEMETRY_FILE` are the only harness
knobs. Nothing else exists (the root Playwright config additionally honors
the Playwright-conventional `CI` and `VIDEO_MODE`).

| Variable                         | Set by                                                  | Controls                                                                                                      | Default                         |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `APP_CONFIG_BASE_URL`            | Doppler (deployed configs); unset in local configs      | THE deployment under test, for every lane                                                                     | Local dev-server discovery file |
| `APP_CONFIG_ADMIN_API_SECRET`    | Doppler                                                 | Admin credential for the itx surface (project seeding, admin lanes)                                           | None — lanes that need it throw |
| `APP_CONFIG_INTEGRATIONS__SLACK` | Doppler                                                 | Gates the slack-agent e2e suite (provides the Slack signing secret)                                           | Unset → suite skips             |
| `E2E_RETRY_TELEMETRY_FILE`       | The preview lane (`scripts/preview/preview.ts`), or you | Where the vitest `RetryTelemetryReporter` writes its JSON (see [Retries and timeouts](#retries-and-timeouts)) | Unset → log line only, no file  |
| `OS_E2E_TUI_PROJECT_ID`          | `e2e/tui-test/run.ts` (internal; passed to the spec)    | The disposable project the TUI spec chats against                                                             | Unset → TUI spec skips          |
| `OS_E2E_TUI_SNAPSHOT`            | You                                                     | `"1"` opts into the manual aesthetic TUI snapshot test                                                        | Skipped                         |
| `GITHUB_SHA`                     | GitHub Actions (ambient)                                | Labels the preview-smoke seed project slug in CI                                                              | `"manual"`                      |
| `CI`                             | GitHub Actions                                          | Playwright: `forbidOnly`, one retry, trace on first retry, never reuse an existing dev server                 | Unset locally                   |
| `VIDEO_MODE`                     | You                                                     | `"1"` makes Playwright record video with relaxed timeouts                                                     | Video only retained on failure  |

## Artifacts

- **The Vitest e2e suite** writes a per-run artifact root under the OS temp dir
  — `os-e2e-*` (`/tmp/os-e2e-*` on Linux/CI) — containing per-test console
  logs. The active root is printed at startup
- **Playwright** writes `test-results/` at the repo root: traces, videos, and
  screenshots under `test-results/playwright-output`, plus HTML and JSON
  reports.
- **Preview CI** collects all of the above (`test-results`,
  `apps/os/test-results`, `/tmp/os-e2e-*`) into the repo-level
  `test-results/` directory, then uploads that one workspace-relative directory
  as a CI artifact. The source paths are tracked as `previewTestArtifacts` in
  `scripts/preview/preview.ts`.

## Retries and timeouts

Every number and retry knob in the e2e system follows five rules. The
constants live in **`packages/shared/src/test-support/e2e-policy/budgets.ts`**
(one file, every config imports it) and
`scripts/preview/e2e-policy.test.ts` guards the invariants — including the
files that can't import TypeScript constants (shell). The evidence behind the
rules is the 50-consecutive-green-run marathon audit in
[preview-e2e-flake-hunt.md](preview-e2e-flake-hunt.md) (~5,800 test
executions: ~0.5% of tests needed their single retry, none ever needed a
second, and every mechanism above the test layer either never fired or fired
only on genuine infra wedges).

1. **Retries live in exactly one layer: the individual test.** The test is
   the smallest unit that owns its state — every test (and every
   onboarding-smoke attempt) provisions its own project — so it is the
   cheapest genuinely independent trial. `E2E_CI_RETRIES = 1` in CI, zero
   locally, everywhere: retrying anything larger re-runs minutes of healthy
   work to re-roll one six-second dice.
2. **Everything above a test is a watchdog: it fails, it never retries.**
   The preview vitest lane gets a hard `timeout`; a whole run gets a
   kill-tree watchdog; the Depot job has `timeout-minutes`. Re-running a
   killed run is the outer edge's job (the Depot re-run button, the next
   push) — never automatic.
3. **Watchdogs are sized to ~2× the healthy p99 of what they bound — never
   to accommodate worst-case retry stacks.** A run burning retries against a
   wedged platform _should_ get killed; both historical watchdog kills were
   genuine infra wedges where retrying was hopeless.
4. **Waits are progress-based; static budgets are backstops.** The
   Playwright `actionTimeout` is a tight 750ms; the middlewright
   spinner-waiter (see `patches/`) extends it — up to ~30s — only while the
   app visibly reports progress. An app that goes blank fails fast instead
   of being slept through: this exact tightness caught a real blank-render
   product bug (flake 21). Don't widen budgets to paper over a missing
   loading state.
5. **Retries are measured, never silent.** With one retry, a
   5%-probability real race turns a run red about once in 400 runs — but
   shows up in retry telemetry about once in 20. The count is the detector;
   see below.

### The ladder

| What it bounds             | Knob                                  | Where                                                                | Value                          | On expiry                   |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------- | ------------------------------ | --------------------------- |
| One UI action              | `actionTimeout` + spinner-waiter      | `playwright.config.ts` ← `SPEC_ACTION_TIMEOUT_MS`                    | 750ms (→ ~30s with spinner)    | fail the attempt            |
| One assertion              | `expect.timeout`                      | `playwright.config.ts` ← `SPEC_EXPECT_TIMEOUT_MS`                    | 15s                            | fail the attempt            |
| One Playwright spec        | `timeout`                             | `playwright.config.ts` ← `SPEC_TEST_TIMEOUT_MS`                      | 90s                            | retry once (CI)             |
| One vitest e2e test/hook   | `testTimeout` / `hookTimeout`         | `apps/os/e2e/vitest.config.ts` ← `E2E_TEST_TIMEOUT_MS`               | 120s                           | retry once (CI)             |
| A container-cold-boot test | per-test `{ timeout }`                | individual tests, capped at `E2E_HEAVY_TEST_TIMEOUT_MS`              | ≤ 240s                         | retry once (CI)             |
| The onboarding smoke gate  | attempt loop                          | `apps/os/e2e/vitest/onboarding-smoke.ts`                             | 90s greeting wait              | one more attempt, then fail |
| The preview vitest lane    | `timeout N pnpm e2e`                  | `scripts/preview/preview.ts` ← `OS_PREVIEW_VITEST_LANE_TIMEOUT_SECS` | 360s                           | **fail — never retry**      |
| One whole preview run      | `RUN_TIMEOUT_SECS` kill-tree watchdog | `scripts/preview/flake-hunt-loop.sh` ← `PREVIEW_RUN_WATCHDOG_SECS`   | 600s                           | **kill — never retry**      |
| The Depot CI job           | `timeout-minutes`                     | `.depot/workflows/*.yml`                                             | 30 (previews) / 300 (marathon) | outer edge: re-run button   |

The ladder is strictly ordered and the guard test asserts it stays that way.
Note the deliberate rule-3 consequence: the 360s lane watchdog does _not_
budget for a heavy test double-burning its 240s cap, and the 600s run
watchdog does not budget for the lane doing that twice.

### Retry telemetry

A retried test is a real failure that a re-roll absorbed — it must stay
visible:

- **Run log**: vitest lanes print `[retry-telemetry] N test(s) needed
retries: ...` (the `RetryTelemetryReporter` in
  `packages/shared/src/test-support/e2e-policy/`); the onboarding smoke
  prints the same marker when it needed attempt 2. Grep any run log for
  `retry-telemetry`.
- **Preview CI**: the os lane writes the vitest telemetry JSON (via
  `E2E_RETRY_TELEMETRY_FILE`) and Playwright's `playwright-results.json`;
  `scripts/preview/preview.ts` folds both into a `retries` column in the
  PR-body table and a `::notice::` annotation (escalating to `::warning::`
  when ≥4 tests retried in one run — that smells slot-wide, not
  probabilistic).
- **Volume**: probabilistic regressions need run volume to detect — that is
  what the on-demand marathon is for
  (`.depot/workflows/preview-e2e-marathon.yml`, N consecutive runs of the
  full preview lane on Depot). Watch the retry counts across a marathon, not
  just the pass/fail streak.

When telemetry trends up without failures, treat it exactly like a budget
`::warning::`: find the cause, don't wait for red.
