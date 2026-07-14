The primary push-conflict path does not recognize the dependency's real rejection error, so the new resolution UI is skipped. The agent and forced-pull alternatives also fail for specific supported scenarios.

Full review comments:

- [P1] Match the actual non-fast-forward push error — /Users/jonastemplestein/.herdr/worktrees/iterate/git-sync/apps/os/src/components/repo-ide/github-history-resolution.ts:13-15
  When “Push now” encounters a genuine non-fast-forward, isomorphic-git 1.37.6 [throws `Push rejected because it was not a simple fast-forward`](https://github.com/isomorphic-git/isomorphic-git/blob/v1.37.6/src/errors/PushRejectedError.js#L3-L15) before `RepoDurableObject` reaches its custom `pushed.ok` message. None of these substrings matches that wording, so `LinkedPanel.onError` shows only a toast and never opens the new resolution UI. Match the typed rejection/reason or its actual message, and test that case.

- [P2] Give the merge agent a publishable sequence — /Users/jonastemplestein/.herdr/worktrees/iterate/git-sync/apps/os/src/components/repo-ide/github-history-resolution.ts:84-86
  On genuinely diverged histories, following step 4 cannot succeed: `commitFiles` creates an ordinary single-parent descendant of the current project head, so GitHub's head never becomes an ancestor and the subsequent non-forced `pushToGithub()` remains non-fast-forward. Since the prompt also forbids force-pushing, instruct the agent to preserve the merged tree, force-sync GitHub as the base, then commit the tree, or provide a way to publish a true two-parent merge.

- [P2] Bound history when force-pulling large repositories — /Users/jonastemplestein/.herdr/worktrees/iterate/git-sync/apps/os/src/components/repo-ide/repo-github-panel.tsx:54-58
  When “Use GitHub's version” is selected for a repository with substantial history, leaving `depth` undefined makes the forced sync clone the entire GitHub history in memory. The sync implementation explicitly notes that even a 21 MB pack can inflate to roughly 290 MB, exceeding the worker's 128 MB limit, so this resolution action fails for such repositories. Pass a bounded depth suitable for UI recovery or use a transfer path that is not isolate-memory-bound.
