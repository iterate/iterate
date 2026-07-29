# Pull requests

## Before open

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

Clean branch off `origin/main`. Don't stack unrelated worktree WIP. Don't commit/push/open a PR unless asked.

## Body

The body becomes the squash-merge commit message. Write it for a reviewer and
future reader, not as a task-file mirror: the net effect once merged,
abbreviated self-contained sample code for new surface area, before/after
output for bug fixes.

Substantive PRs get a **risk map** section:

- The riskiest part of the diff and why — trust boundaries, state machines,
  anything whose correctness rests on an argument rather than a test.
- What to expect on merge: behavior changes, invalidated data, stale clients,
  operational follow-ups.
- A suggested review order, highest-attention files first, mechanical changes
  last.

A reviewer should know where to spend attention before opening the diff.

Session id at the bottom.

## Media in the PR body

Include screenshots or short videos whenever visual review helps.

**Relative paths do not render in PR descriptions.**

```markdown
<!-- broken -->

![ui](docs/pr-assets/foo.png)

<!-- works — commit the asset, then absolute URL to the branch -->

![ui](https://github.com/iterate/iterate/raw/<branch>/docs/pr-assets/foo.png)
```

Also fine: `raw.githubusercontent.com/.../<sha>/...` or `user-attachments/assets/...`. Smoke-check with `curl -sI -L` → 200.

### Video

A real inline **player** only renders from a
`github.com/user-attachments/assets/...` URL. GitHub sanitises `<video>`
pointing at any other host — link at best, never a player. (GIFs render from
any URL.)

Mint the URL through any PR page's comment editor: upload via the attach flow
(a browser-automation `file_upload` tool pointed at the editor's file input
works), wait for the inserted `user-attachments` URL, then clear the comment
WITHOUT submitting — the asset is already permanent. Put the bare URL in the
body on its own line with blank lines above and below.

Keep clips small: re-encode (`ffmpeg -vf scale=960 -crf 30`), strip audio,
convert webm → mp4.

Spec recordings: `VIDEO_MODE=1 pnpm spec -g <name>`. Ship
`video-rendered.webm` (dead air sped up, pointer annotations) — `video.webm`
is the raw capture.

Verify the player rendered:

```bash
gh api repos/iterate/iterate/pulls/<n> -H "Accept: application/vnd.github.html+json" --jq .body_html | grep -c '<video'
```

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
