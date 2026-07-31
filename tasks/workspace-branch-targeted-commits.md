---
state: todo
priority: medium
size: medium
tags: [os, workspaces, git, architecture]
---

# Branch-targeted commits from workspaces

Platform follow-up split out of
[workspace-lenses-consolidation](workspace-lenses-consolidation.md) (item 5
there, 2026-07-31). Today every mount is commit-to-main: `git.commit({
message, scope })` turns one mount's entire dirty set into one commit on that
repo's main. The missing verb: with several repos mounted and local
modifications spread across them, commit a chosen SUBSET of one mount's
changes to a chosen BRANCH of that repo —

```ts
git.commit({ scope, branch, paths? });
```

so a jam session can end in "these task files → main, that refactor → a
draft-PR branch".

## Notes

- The workspace README already sketches the branch-mode policy (draft-PR
  synthesis on GitHub-linked repos via the Git Database API); this extends it
  from a per-mount policy to a per-commit choice.
- `paths?` selects a subset of the mount's dirty set; only the committed
  paths clear from the overlay — the rest stay dirty.
- Also the honest answer for "create tasks in the iterate/iterate repo": a
  commit to `/repos/iterate` lands on the project's clone, so the real
  materialization is a branch + PR through the GitHub lane, never clone-main.
