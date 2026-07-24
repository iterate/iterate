---
status: complete
size: small
---

# Add structure guidance rules

## Status summary

Complete in draft PR #2305. Four structure rules now cover conditional shape, small helpers,
truthiness, and validation of unknown values. The first 20-file sample was reviewed and its
counterexamples were folded back into the conditional and unknown-shape rules.

## Spec

- [x] Add the submitted structure guidance. *The helper and truthiness rules retain their submitted
      wording; review feedback refined the conditional rule and added unknown-shape validation.*
- [x] Remove the superseded `no-small-single-use-helper.md` rule. *Committed in `70c85b38b`.*
- [x] Test the rules against a representative source sample. *PR #2306 applies them to exactly 20
      handwritten source files and supplied five review counterexamples.*
- [x] Open a draft PR based on current `origin/main`. *Opened PR #2305 from
      `rules/structure-guidance`.*

## Decisions and assumptions

- The original submitted contents were the starting point. Later explicit user feedback authorizes
  the conditional rewrite, the unknown-shape rule, and the corrected truthiness filename.
- Unrelated root-worktree changes are out of scope and will remain untouched.

## Implementation log

- Created the branch from `origin/main` at `aad216987`.
- Committed the task specification before transferring the rule files.
- Left the root worktree unchanged, including all unrelated staged and unstaged changes.
- Renamed the truthiness rule to `simplify-truthiness-checks.md` without changing its bytes.
- Replaced the mechanical multiline-ternary rule with `prefer-clear-conditionals`: early returns
  remain preferred for exceptional branches, while value selection, shared work, positive
  predicates, mutation, and total vertical space decide whether a ternary should stay.
- Added `validate-unknown-shapes`: unknown values should cross a schema or domain guard instead of
  an anonymous chain of runtime checks.
