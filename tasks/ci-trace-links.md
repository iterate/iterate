# CI trace dependencies and waiting appearance

Status: implementation complete; browser and scripts checks pass. Real preview
validation and review remain. The broad test run found an unrelated expired
quarantine date in `specs/repo-ide-jsonc.spec.ts`.

Show the explicit dependencies behind CI waits without changing scheduling or
coordination. Keep the existing self-contained viewer and standard OTLP data.

- [x] Record lightweight dependency/milestone markers from the existing status CLI, retaining exact producer attempt identity. _`status.ts` emits one dependency per observed producer and a marker after milestone publication._
- [x] Assemble OTLP span links for preview-ready waits and the finalizer's wait for test jobs to settle. Missing evidence must not imply readiness succeeded. _`assembleTrace()` resolves links after all jobs, retaining missing/never-started evidence._
- [x] Show labelled curved dependency arrows on selection/tap, with useful detail links and keyboard access. Avoid permanently drawing a graph over the waterfall. _Selection draws an SVG overlay; detail buttons reveal the original endpoints._
- [x] Render waiting spans and their legend with diagonal yellow stripes; keep incomplete evidence visually distinct. _Yellow waiting stripes and grey incomplete stripes have separate legend/help text._
- [ ] Test dependency assembly, including failed/missing milestones and attempt identity; browser-check selection, collapsed rows, zoom and narrow screens.
- [ ] Validate a real preview trace, add visual evidence and the Change / Purpose table to the PR, and address review feedback.

Assumptions: only explicit cross-job waits are in scope. Parent/child nesting
stays unchanged. No scheduling, polling interval, retry or timeout changes; no
new tracing backend or viewer dependency. Old reports without span links remain
readable.

## Implementation log

- Initial scope from the CI tracing follow-up conversation. The status CLI already
  resolves the producer identity, so record that rather than infer dependencies
  from adjacent bars or job names.
