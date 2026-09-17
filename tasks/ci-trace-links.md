# CI trace dependencies and waiting appearance

Status: scoped; implementation and validation remain.

Show the explicit dependencies behind CI waits without changing scheduling or
coordination. Keep the existing self-contained viewer and standard OTLP data.

- [ ] Record lightweight dependency/milestone markers from the existing status CLI, retaining exact producer attempt identity.
- [ ] Assemble OTLP span links for preview-ready waits and the finalizer's wait for test jobs to settle. Missing evidence must not imply readiness succeeded.
- [ ] Show labelled curved dependency arrows on selection/tap, with useful detail links and keyboard access. Avoid permanently drawing a graph over the waterfall.
- [ ] Render waiting spans and their legend with diagonal yellow stripes; keep incomplete evidence visually distinct.
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
