---
status: in-progress
size: medium
---

# Clickable CI trace reports

The collector, OTLP model, interactive viewer and publication workflow are implemented. Local checks pass; live CI publication and browser verification are in progress. Build on main after #2658 and #2659, not the Cloudflare tracing experiment.

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
- [ ] Render an interactive trace with readable setup/wait/test phases, drilldown, search and mobile support.
- [ ] Publish immutable report links and automatically update the correct PR's body.
- [ ] Wire automatic collection and cancellation reconciliation, with visible reporting failures.
- [ ] Exercise the real publication path on this PR's own CI run and verify its body link in an isolated browser.
- [ ] Run required checks, handle review feedback, document operating/replay commands and include a screenshot in the PR.

## Implementation log

Session: `01a09f64-ea4e-7c61-ab0a-c15eb65df3bc`.

- Implemented shell lifecycle markers before dependency installation, a Playwright lifecycle reporter, OTLP assembly, a standalone viewer and a separate publication workflow.
- Live Depot records include authored `stepId`/`stepName`; use those instead of the runner’s generated `GITHUB_ACTION` labels.
- The first full test run exposed contention from nesting Playwright inside Vitest. Keep the reporter regression test as a lightweight isolated Node process; the real Playwright probe passed separately and preview provides integration proof. No timeout changes.
