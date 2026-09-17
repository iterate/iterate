# CI trace dependencies and waiting appearance

Status: implementation and acceptance checks complete. A real preview passed all
nine jobs and published a report with 14 validated dependency links. The unrelated
expired quarantine was fixed upstream in #2700 and is included in the main merge.

Show the explicit dependencies behind CI waits without changing scheduling or
coordination. Keep the existing self-contained viewer and standard OTLP data.

- [x] Record lightweight dependency/milestone markers from the existing status CLI, retaining exact producer attempt identity. _`status.ts` emits one dependency per observed producer and a marker after milestone publication._
- [x] Assemble OTLP span links for preview-ready waits and the finalizer's wait for test jobs to settle. Missing evidence must not imply readiness succeeded. _`assembleTrace()` resolves links after all jobs, retaining missing/never-started evidence._
- [x] Show labelled curved dependency arrows on selection/tap, with useful detail links and keyboard access. Avoid permanently drawing a graph over the waterfall. _Selection draws an SVG overlay; detail buttons reveal the original endpoints._
- [x] Render waiting spans and their legend with diagonal yellow stripes; keep incomplete evidence visually distinct. _Yellow waiting stripes and grey incomplete stripes have separate legend/help text._
- [x] Test dependency assembly, including failed/missing milestones and attempt identity; browser-check selection, collapsed rows, zoom and narrow screens. _11 tracing tests pass; desktop/390px browser checks cover selection, keyboard navigation, endpoint reveal and older data without links._
- [x] Validate a real preview trace, add visual evidence and the Change / Purpose table to the PR, and address review feedback. _Preview `48dppx2ct3` passed all nine jobs; the public artifact has 209 spans and 14 links. PR #2697 includes the screenshot/table; independent review found no blockers and its zoom suggestion is fixed._

Assumptions: only explicit cross-job waits are in scope. Parent/child nesting
stays unchanged. No scheduling, polling interval, retry or timeout changes; no
new tracing backend or viewer dependency. Old reports without span links remain
readable.

## Implementation log

- Initial scope from the CI tracing follow-up conversation. The status CLI already
  resolves the producer identity, so record that rather than infer dependencies
  from adjacent bars or job names.

- Validation: 363 scripts tests (11 tracing tests), repository typecheck/lint,
  Knip and scoped formatting pass. Browser checks cover desktop and 390px
  layouts, keyboard/name selection, collapse/search, zoom restoration and old
  reports without links. Public report:
  https://depot-01a0ae0f-99ce-730f-b70d-29f9939d23d5--iterate.iterate.app/
- Full `pnpm test` and Depot's Test job fail on the existing quarantine date
  (2026-09-16) in `specs/repo-ide-jsonc.spec.ts:19`. No quarantine, test
  expectation, retry or timeout was changed.
- Review follow-up: selecting a parent no longer includes its descendants'
  dependency arrows or detail links. Expand a Wait phase and select the measured
  wait step to see its own links. Browser checks verify empty parent selections,
  readiness on the wait step and cleanup's direct link to the job; 11 tracing tests pass.
