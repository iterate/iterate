status: in-progress
size: medium
branch: fix/restore-ai-linter-rules

# Restore GitHub AI lint reviews

Status: Diagnosing the production rule-loading and GitHub review path. The
likely stale rule configuration is identified; the live PR proof and any
required production config repair are still missing.

## Goal

Restore `iterate[bot]` reviews for this repository and add an AI lint rule that
rejects metaphorical uses of `lane`, `door`, and `seam` unless a nearby comment
explains why the word is literal or justified.

## Assumptions

- Root `rules/**/*.md` remains the canonical rule source for this repository.
- The rule should target identifiers and prose in code, not genuine traffic
  lanes, physical doors, or actual joined/material seams.
- A short comment immediately above an intentional non-literal use is the
  explicit escape hatch.
- The task is complete only when a deliberately offending variable in this PR
  causes a visible `iterate[bot]` review comment.

## Checklist

- [ ] Reproduce the missing AI lint run from a fresh PR and capture the failed stage.
- [ ] Repair the stale rule-loading/configuration path without hiding failures.
- [ ] Add the banned-metaphor rule to the canonical rules and hosted linter config.
- [ ] Add one obvious offending variable solely as an end-to-end review probe.
- [ ] Prove `iterate[bot]` comments on that variable, then preserve the proof in the PR.
- [ ] Run focused tests and checks for every changed code/config surface.
- [ ] Move this task to `tasks/complete/` once the live proof and CI are green.

## Implementation log

- 2026-08-25: Started from `origin/main` in a dedicated worktree. Initial
  inspection found that `configs/default/worker.ts` still configures the deleted
  `rules/structure/no-small-single-use-helper.md`, while the canonical root rule
  was replaced by four newer structure rules in PR #2305.
