# Pull requests

## Before open

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

Clean branch off `origin/main`. Don't stack unrelated worktree WIP. Don't commit/push/open a PR unless asked.

## Screenshots in the PR body

**Relative paths do not render in PR descriptions.**

```markdown
<!-- broken -->

![ui](docs/pr-assets/foo.png)

<!-- works — commit the asset, then absolute URL to the branch -->

![ui](https://github.com/iterate/iterate/raw/<branch>/docs/pr-assets/foo.png)
```

Also fine: `raw.githubusercontent.com/.../<sha>/...` or `user-attachments/assets/...` (needed for inline video). Smoke-check with `curl -sI -L` → 200.

`gh pr edit` sometimes fails on this repo (GraphQL classic Projects deprecation). REST works:

```bash
gh api -X PATCH repos/iterate/iterate/pulls/<n> --input payload.json
```

## Drafts / previews

Drafts don't get a preview unless labeled `preview` or marked ready. Lease details: [Dev environments](./dev-environments.md).

## After open — agents landing a PR

These rules apply whenever an agent is asked to open, babysit, address review, or merge a PR. A human may override them explicitly for one PR; do not invent overrides.

### Wait for reviews (especially Iterate Review)

- **Do wait** for **Iterate Review** (and other review bots that post threads) to finish before treating the PR as “done,” unless the human says not to.
- “Pass” / “success” / “skipping” on the check is not enough if the review agent is still writing comments — re-poll review threads until the run is finished and threads are accounted for.
- Prefer waiting for **Cursor Bugbot** and **Iterate Review** over merging on lint/test green alone.

### Address every review / CI comment

- Treat **inline review threads** (Iterate Review, Bugbot, humans) as work items. For each:
  1. **Fix** the code if the comment is right, **or**
  2. **Reply** explaining why it does not apply (with a real reason, not a brush-off).
  3. **Resolve** the thread after the fix or the reply.
- **Do not leave threads standing** and merge. Unresolved = not finished.
- “Doesn’t apply” is fine **with a comment**; silent resolve or silent merge is not.

### CI and merge

- **Never merge when required CI is red** unless the human **explicitly** asked to merge despite failures.
- Autofix / preview flakiness: investigate; re-run or fix when you can. Do not use a red check as “close enough.”
- If an unrelated flaky or pathologically slow test is quarantined under the
  [testing protocol](./testing.md#flaky-test-quarantine-protocol), the PR body
  must prominently name the skipped test/lane and link its task. A hidden skip
  is not green CI.
- When the human asks to merge: wait for green CI **and** zero unresolved review threads, then merge (squash unless told otherwise).
- Do not commit, push, open, or merge a PR unless the human asked for that action (or a standing instruction for this session clearly includes it).
