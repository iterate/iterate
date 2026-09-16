---
status: complete
size: medium
---

# Clickable CI trace reports

Implemented in PR #2681. Reports now upload to Depot artifacts and are served by an independent route in `iterate/config`; generated Git commits and use of the explainer host have been removed. Local trace and route checks pass. A real collector uploaded a Depot artifact, verified its public URL and created a CI trace commit status automatically; browser drilldown and OTLP download are verified. A fresh preview is queued behind the existing main preview.

## Request

Automatically publish a **CI trace** commit status whose Details link opens an interactive trace of that commit's preview CI run. The user's acceptance check is clicking that link and seeing the trace. This replaces the initially requested PR-body link. Scope: workflow, jobs, steps and Playwright test attempts. Deployed request tracing and Vitest test instrumentation are excluded.

## Decisions and assumptions

- Produce a self-contained HTML report plus standard OTLP JSON with the same spans. Reuse the previous explainer's setup/wait/test grouping and expand-one-level behavior.
- Use actual Depot workflow/job/attempt identities and timestamps, plus existing Playwright reporter evidence. Retain retries and distinguish incomplete/cancelled evidence. Never infer a quiet command's entire duration from its stdout.
- Upload generated HTML/OTLP JSON to Depot. Serve it through the config worker’s `/depot/artifacts/<id>` route with its existing Depot token. No generated Git commits.
- Prefer completed-run reports initially. A collector outside the observed workflow must handle its final timestamps; the existing periodic CI telemetry workflow can provide reconciliation for cancellation/missing finalizers.
- Only sanitized names, timings, statuses and source locations belong in the public report. No raw logs, error payloads, auth data or signed download URLs.
- Publish to the tested head SHA, with one **CI trace** status per commit. Replays are idempotent and older executions must not replace newer links. The collector no longer needs PR write access.
- No product changes, extra test retries, or timeout increases to make this work. No merge without the user's request.

## Acceptance

- [x] Assemble correct parent relationships from measured CI/test evidence, including retries and missing evidence. *`scripts/ci/tracing/tracing.ts`; regression coverage for quiet steps, retries and cancelled runners.*
- [x] Render an interactive trace with readable setup/wait/test phases, drilldown, search and mobile support. *`scripts/ci/tracing/viewer.html`; desktop/mobile, expand, search, details, zoom and OTLP download checked in isolated Playwriter.*
- [x] Publish immutable report links and automatically update the correct PR's body. *Preview `7rlclr2zqf` automatically dispatched collector `r5fxsp0gq5`; published in 26s and added the link to #2681.*
- [x] Wire automatic collection and cancellation reconciliation, with visible reporting failures. *`ci-trace.yml` callback plus bounded 24h scheduled scan; cancellation model regressions.*
- [x] Exercise the real publication path on this PR's own CI run and verify its body link in an isolated browser. *Clicked the auto-added GitHub link anonymously, inspected a recovered retry, zoomed and downloaded the OTLP file. 93 attempts, unique span IDs, valid parent links.*
- [x] Run required checks, handle review feedback, document operating/replay commands and include a screenshot in the PR. *Full typecheck/lint/knip/format and tests passed; CI lint/test/autofix and Bugbot passed on `399b70346`. `docs/ci-traces.md` covers replay; PR includes the published report screenshot. The shell argument-index bot claim was disproved with an executable check and resolved.*

## Implementation log

Session: `01a09f64-ea4e-7c61-ab0a-c15eb65df3bc`.

- Implemented shell lifecycle markers before dependency installation, a Playwright lifecycle reporter, OTLP assembly, a standalone viewer and a separate publication workflow.
- Live Depot records include authored `stepId`/`stepName`; use those instead of the runner’s generated `GITHUB_ACTION` labels.
- The first full test run exposed contention from nesting Playwright inside Vitest. Keep the reporter regression test as a lightweight isolated Node process; the real Playwright probe passed separately and preview provides integration proof. No timeout changes.

- Human PR feedback requested commands instead of `run / run 2`. Added authored commands from the triggering workflow revision, stripping Doppler wrappers without copying expanded log commands. Checked the real run data with the updated viewer.
- Local full typecheck/lint/knip/format passed. Full suite passed with two concurrent workspaces; scripts suite now has 356 passing tests. The next push includes the one-line logical-spread autofix requested by CI.

- The second complete preview (`lm7pqp0q35`) published automatically in 21 seconds after collector startup, with 92 test attempts and no retries. The third run verifies authored command labels.
- Count only jobs with real runner attempts in the header, so a cancellation before runner startup does not inflate the count. Unstarted jobs remain visible with zero duration and explicit evidence.
- Reports are immutable, public files on the separate `codex/ci-trace-artifacts` branch. Pruning and live OTLP export remain separate future work; shell/Playwright instrumentation is complete for this scope.

- Follow-up: preparation now has measured nested operations for provisioning/deployment, slot acquisition and erase, per-app build/deploy and HTTP readiness, and shared rollout/smoke/TUI readiness. Async context keeps concurrent app children under the right parent; failed results and incomplete operations remain visible. A child-process integration regression exercises recording through OTLP assembly, alongside the preview regressions.

- Live follow-up found progress output without a newline joining two operation markers; the regression now reproduces that exact output shape and markers start on a fresh line. Also declared Kit’s actual Worker entry in Knip: removing the generated Wrangler config reproduced CI’s unused-file failure, and the explicit entry fixes the race with parallel typecheck generation.

- Follow-up: publish the report as a **CI trace** commit status with an external target URL. Removed PR-body writes and changed collector permissions to `statuses: write`; replay/newest-execution coverage remains. Replayed the real published run and verified its status ID was unchanged, then checked its external target URL. 357 scripts tests, scripts typecheck and scoped lint passed.

- Consolidated tracing under `scripts/ci/tracing/`: `tracing.ts`, `cli.ts`, `shell.sh`, `viewer.html` and one `tracing.test.ts`. Updated imports, Playwright reporters, workflow commands and change-detection paths. All 357 scripts tests, scripts/specs typechecks and scoped lint passed; the moved CLI reproduced the published real run’s 203 spans exactly.

- Replaced generated artifact-branch commits with the standard Depot-compatible artifact upload action and a config-repo route that unpacks reports on demand. Dropped Git contents write permission. The scheduled repair dispatches collectors only for missing execution statuses. Earlier explainer/PR-body notes above describe superseded publication designs.

- Live acceptance: config `878c828` serves the Depot archive independently of explainers. Collector `rrm65p27zc` uploaded artifact `01a0ac01-8b6c-7633-a515-c7558aa9540c` and automatically created status `54321271382` on the source commit. The newer completed preview’s artifact `01a0abfc-45e7-7da2-b4fa-f3f1cae2e1d7` has 207 unique spans with valid parents; browser download equals the JSON endpoint. Drilldown works with no browser errors and the sandbox denies host storage access. Unrelated artifacts return 404; post-fix route error telemetry is empty.
- Merged main without rewriting history. The only conflict was the Kit Knip comment, now identical to main. A local Workers-runtime probe identified the initial config serving error (calling global fetch with the wrong receiver); the deployed fix passed the same probe and live requests. Full preview `p62xxs9fz2` on `183bd829b` was dispatched through the serialized main workflow because GitHub’s PR head metadata lagged the pushed branch. The global PR monitor is tracking it.
