---
status: complete
size: medium
---

# Clickable CI trace reports

Implemented in PR #2681. Real preview runs automatically published interactive reports and updated the PR; the anonymous browser click-through, drilldown and OTLP download work. Commands come from the triggering workflow revision with Doppler wrappers removed. Built on main after #2658 and #2659.

## Request

Automatically add a link to each PR body that opens a useful interactive trace of its preview CI run. The user's acceptance check is clicking that link and seeing the trace. Scope: workflow, jobs, steps and Playwright test attempts. Deployed request tracing and Vitest test instrumentation are excluded.

## Decisions and assumptions

- Produce a self-contained HTML report plus standard OTLP JSON with the same spans. Reuse the previous explainer's setup/wait/test grouping and expand-one-level behavior.
- Use actual Depot workflow/job/attempt identities and timestamps, plus existing Playwright reporter evidence. Retain retries and distinguish incomplete/cancelled evidence. Never infer a quiet command's entire duration from its stdout.
- Publish through the existing branch-aware Iterate explainer host. Keep generated run reports separate from application source commits; determine the smallest durable storage mechanism during implementation.
- Prefer completed-run reports initially. A collector outside the observed workflow must handle its final timestamps; the existing periodic CI telemetry workflow can provide reconciliation for cancellation/missing finalizers.
- Only sanitized names, timings, statuses and source locations belong in the public report. No raw logs, error payloads, auth data or signed download URLs.
- Update a dedicated managed PR-body section, preserving human text and other automation. An older run must not replace the latest run for the current head.
- No product changes, extra test retries, or timeout increases to make this work. No merge without the user's request.

## Acceptance

- [x] Assemble correct parent relationships from measured CI/test evidence, including retries and missing evidence. *`trace-model.ts`; regression coverage for quiet steps, retries and cancelled runners.*
- [x] Render an interactive trace with readable setup/wait/test phases, drilldown, search and mobile support. *`trace-viewer.html`; desktop/mobile, expand, search, details, zoom and OTLP download checked in isolated Playwriter.*
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
