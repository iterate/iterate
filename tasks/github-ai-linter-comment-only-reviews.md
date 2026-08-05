---
status: in-progress
size: small
---

# Make clean AI lint runs silent and findings comment-only

> **Status summary:** Implementation is complete and targeted tests are green. Clean analyses now settle as skipped without a GitHub call; findings publish comment-only reviews. Full repository checks and PR review remain.

The Iterate GitHub AI linter currently approves pull requests when it finds no
issues and requests changes when it leaves findings. Both actions overstate the
linter's authority: the status check already communicates a clean run, and AI
findings can be false positives.

## Acceptance criteria

- [x] A successful analysis with no visible diagnostics and no qualitative concerns does not create a GitHub review. The existing green status check remains the clean signal. _The publisher returns the explicit `skipped` result before acquiring the GitHub integration._
- [x] A successful analysis with visible diagnostics creates a `COMMENT` review, never `REQUEST_CHANGES`, regardless of diagnostic severity or the agent's qualitative verdict. _`publishGithubAiLinterReview` uses the fixed non-blocking event._
- [x] Suppressed diagnostics alone do not cause a review to be created. _The processor test's second analysis reports and suppresses its only diagnostic, then verifies no second GitHub call._
- [x] Publication state and events still settle coherently when a clean analysis intentionally skips GitHub review creation. _The contract models `skipped` as a terminal publication result._
- [x] Tests cover both comment-only findings and a clean/suppressed-only run. _Covered together in `ai-linter.test.ts` through the public processor and publisher path._
- [x] Linter documentation and prompt text no longer claim that it authors approvals or change requests. _Updated the GitHub agents guide plus both linter and conversational agent policies._

## Implementation notes

- Keep the decision deterministic in the stream processor/publisher boundary;
  do not ask the LLM to choose GitHub review authority.
- Preserve the check-run behavior. This task only changes review publication.

## Implementation log

- 2026-08-05: Added the terminal `skipped` publication result, fixed all
  created reviews to `COMMENT`, and updated policies/docs. Targeted linter
  processor tests pass.
