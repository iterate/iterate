---
status: complete
size: small
---

# Add structure guidance rules

## Status summary

Complete in draft PR #2305. The branch contains this task record and the user's exact four path
changes under `rules/structure/`; no rule wording, filenames, or formatting was edited.

## Spec

- [x] Preserve the three new `rules/structure` files byte-for-byte. *SHA-256 matches the root
      worktree for all three files.*
- [x] Remove the superseded `no-small-single-use-helper.md` rule. *Committed in `70c85b38b`.*
- [x] Verify the resulting `rules/structure` diff matches the root worktree exactly. *Confirmed the
      deletion and matching content hashes before commit.*
- [x] Open a draft PR based on current `origin/main`. *Opened PR #2305 from
      `rules/structure-guidance`.*

## Decisions and assumptions

- “Verbatim” means misspellings, punctuation, examples, and formatting are intentional.
- Unrelated root-worktree changes are out of scope and will remain untouched.

## Implementation log

- Created the branch from `origin/main` at `aad216987`.
- Committed the task specification before transferring the rule files.
- Left the root worktree unchanged, including all unrelated staged and unstaged changes.
