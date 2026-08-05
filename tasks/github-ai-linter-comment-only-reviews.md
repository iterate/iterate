---
status: in-progress
size: small
---

# Make clean AI lint runs silent and findings comment-only

> **Status summary:** Specified and ready to implement. The change is limited to GitHub review publication: clean analyses should publish no review, while analyses with visible findings should publish a non-blocking comment review. Tests and user-facing linter docs still need updating.

The Iterate GitHub AI linter currently approves pull requests when it finds no
issues and requests changes when it leaves findings. Both actions overstate the
linter's authority: the status check already communicates a clean run, and AI
findings can be false positives.

## Acceptance criteria

- [ ] A successful analysis with no visible diagnostics does not create a GitHub review. The existing green status check remains the clean signal.
- [ ] A successful analysis with visible diagnostics creates a `COMMENT` review, never `REQUEST_CHANGES`, regardless of diagnostic severity or the agent's qualitative verdict.
- [ ] Suppressed diagnostics alone do not cause a review to be created.
- [ ] Publication state and events still settle coherently when a clean analysis intentionally skips GitHub review creation.
- [ ] Tests cover both comment-only findings and a clean/suppressed-only run.
- [ ] Linter documentation and prompt text no longer claim that it authors approvals or change requests.

## Implementation notes

- Keep the decision deterministic in the stream processor/publisher boundary;
  do not ask the LLM to choose GitHub review authority.
- Preserve the check-run behavior. This task only changes review publication.
