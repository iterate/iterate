---
status: complete
size: small
---

# Make clean AI lint runs silent and findings comment-only

> **Status summary:** Done, including review follow-up. Clean analyses publish a green Check Run and no review; findings publish a neutral Check Run plus a comment-only review. Tests and PR CI are green.

Before this task, the Iterate GitHub AI linter approved pull requests when it
found no issues and requested changes when it left findings. Both actions
overstated the linter's authority: the status check already communicates a
clean run, and AI findings can be false positives.

## Acceptance criteria

- [x] A successful analysis with no visible diagnostics and no qualitative concerns does not create a GitHub review. The existing green status check remains the clean signal. _The publisher returns the explicit `skipped` result before acquiring the GitHub integration._
- [x] A successful analysis with visible diagnostics creates a `COMMENT` review, never `REQUEST_CHANGES`, regardless of diagnostic severity or the agent's qualitative verdict. _`publishGithubAiLinterReview` uses the fixed non-blocking event._
- [x] Suppressed diagnostics alone do not cause a review to be created. _The processor test's second analysis reports and suppresses its only diagnostic, then verifies no second GitHub call._
- [x] Publication state and events still settle coherently when a clean analysis intentionally skips GitHub review creation. _The contract models `skipped` as a terminal publication result._
- [x] Tests cover both comment-only findings and a clean/suppressed-only run. _Covered together in `ai-linter.test.ts` through the public processor and publisher path._
- [x] Linter documentation and prompt text no longer claim that it authors approvals or change requests. _Updated the GitHub agents guide plus both linter and conversational agent policies._
- [x] Every successful analysis publishes an explicit status check. _Clean analyses conclude `success`; findings conclude `neutral` so advisory comments remain non-blocking._
- [x] Changed agent-policy payloads use new idempotency versions. _The linter prompt is v3 and conversational PR policy is v5, preventing conflicts with existing stream events._

## Implementation notes

- Keep the decision deterministic in the stream processor/publisher boundary;
  do not ask the LLM to choose GitHub review authority.
- Preserve the check-run behavior. This task only changes review publication.

## Implementation log

- 2026-08-05: Added the terminal `skipped` publication result, fixed all
  created reviews to `COMMENT`, and updated policies/docs. Targeted linter
  processor tests pass.
- 2026-08-05: Full monorepo typecheck, lint, and Knip pass locally. The local
  parallel test run hit host-wide ephemeral-port exhaustion (15,659 of 16,384
  ports in `TIME_WAIT`); the PR's complete Depot test job passed on a clean
  runner, along with every other check.
- 2026-08-05: Review follow-up added idempotent GitHub Check Runs and bumped
  both changed agent-policy versions after human and Bugbot comments.
- 2026-08-05: A second Bugbot pass prompted check-first publication for
  findings. The neutral Check Run now lands before the immutable review, so a
  Check Runs API failure cannot orphan a review-only write.
