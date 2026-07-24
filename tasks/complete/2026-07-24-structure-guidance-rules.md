---
status: complete
size: small
---

# Add structure guidance rules

## Status summary

Complete in draft PR #2305. The branch contains this task record and the user's submitted rule
contents under `rules/structure/`; no rule wording or formatting was edited. The user subsequently
corrected the `simplifyy-truthiness-checks.md` path typo.

## Spec

- [x] Preserve the three new `rules/structure` files byte-for-byte. *SHA-256 matches the root
      worktree for all three files.*
- [x] Remove the superseded `no-small-single-use-helper.md` rule. *Committed in `70c85b38b`.*
- [x] Verify the resulting `rules/structure` diff matches the root worktree exactly. *Confirmed the
      deletion and matching content hashes before commit.*
- [x] Open a draft PR based on current `origin/main`. *Opened PR #2305 from
      `rules/structure-guidance`.*

## Decisions and assumptions

- “Verbatim” applies to rule contents. The user explicitly corrected the
  `simplifyy-truthiness-checks.md` filename after the first push.
- Unrelated root-worktree changes are out of scope and will remain untouched.

## Implementation log

- Created the branch from `origin/main` at `aad216987`.
- Committed the task specification before transferring the rule files.
- Left the root worktree unchanged, including all unrelated staged and unstaged changes.
- Renamed the truthiness rule to `simplify-truthiness-checks.md` without changing its bytes.
