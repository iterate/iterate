---
status: complete
---

# CLI help makes the unit test depend on production

The fix and regression tests pass locally and in the full Depot Test workflow.
Prepared for review on `codex/cli-help-offline`; main's source is unchanged.

- [x] Identify the latest main failure. *`70f01f42e`, Test / test job `q6bn0sfzvc`: the strip-only CLI loader test took 6456ms and exceeded its 5000ms test deadline.*
- [x] Reproduce the network dependency. *A local OS server delayed by 5500ms made plain `iterate --help` take 5844ms; it requested `/api/trpc-cli-procedures`.*
- [x] Prove the regression before fixing it. *The existing bin test now uses an isolated CLI config and local HTTP server. It fails on the old code because help contacts OS, then passes with no request after the fix.*
- [x] Keep top-level help local and preserve remote command discovery. *`getCli` only discovers remote commands when a root command is requested; help directs users to `iterate os --help`. A second public-bin test verifies that command still loads the configured server's commands.*
- [x] Run local checks. *All 26 CLI tests pass; help takes 331ms. Package typecheck, scoped lint, formatting and diff checks pass.*
- [x] Complete the full patched Depot Test workflow. *[Run `x07zf093lh`](https://depot.dev/orgs/0p91s0lz49/workflows/n88nk0bx47?job=1pr4l00wh2&repo=iterate%2Fiterate) succeeded at 14:23:51 UTC; all 323 iterate package tests pass and the whole workspace suite passes. The help regression takes 508ms in CI.*
- [x] Validate against updated main before opening the PR. *Fast-forwarded to `dd1a72e59`; full install, typecheck, lint, knip and formatting pass. [Full Depot validation](https://depot.dev/orgs/0p91s0lz49/workflows/l9pvpxngth?job=sc8hslkpgq&repo=iterate%2Fiterate) succeeded at 15:01:36 UTC, with the help regression passing in 2059ms under the concurrent workspace workload.*

## Investigation log — 2026-09-16

The original main failure is recorded at
https://depot.dev/orgs/0p91s0lz49/workflows/ldnsp7xnzw?job=q6bn0sfzvc&repo=iterate%2Fiterate.
The test starts the real Node CLI with `--help`. With no root command,
`getCli` fetched the configured OS server's command list before printing help.
Without isolated configuration, this reaches production (or the developer's
configured environment). Server response time therefore affects a unit check.

An unmodified Depot baseline (`p1gw7rpf4h`) passed the CLI test in 3015ms,
consistent with the varying timings observed locally. That rerun does not
remove the network dependency; the regression test checks requests directly.
No test deadline or retry count was increased.

Depot attached the first local-patch run to the base commit's GitHub check,
so `Test / test` displayed success on `70f01f42e` before the fix was committed.
That result included the patch; it did not mean the source fix was on main.
The second validation uses a distinct `CLI help validation / test` check name.

Logs on the investigating machine:

- `/tmp/test-main-70f01f4.log`: original failure.
- `/tmp/test-main-baseline.log`: unmodified Depot baseline.
- `/tmp/iterate-cli-help-fixed.log`: 26 passing CLI tests.
- `/tmp/iterate-cli-typecheck.log`: package typecheck.
- `/tmp/test-cli-help-fixed-depot.log`: full patched Depot workflow.
