# Pull requests

> **Enforcement:** a Claude Code hook ([scripts/hooks/pr-guidance-gate.sh](../scripts/hooks/pr-guidance-gate.sh))
> blocks PR-mutating `gh` commands until this doc's current content hash appears in the command
> as a `PR_GUIDANCE_HASH=<hash>` prefix. The deny message contains this whole doc plus the hash,
> so just follow what it says. Editing this file changes the hash and re-arms the gate for
> everyone — that's intended.

## Before open

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test
```

Clean branch off `origin/main`. Don't stack unrelated worktree WIP. Don't commit/push/open a PR unless asked.
Describe the concrete behavior change and how you validated it.

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

CI writes managed sections into the PR body on each push: `<!-- loc-report -->…<!-- /loc-report -->` (the LOC table, `scripts/ci/loc-report.ts`), `<!-- os-preview:begin -->…<!-- os-preview:end -->` (the preview links), and Bugbot's `<!-- CURSOR_SUMMARY -->…<!-- /CURSOR_SUMMARY -->`. Editing the description does not rewrite them.

To edit a body, fetch the current one and change only your own text around those sections. Never PATCH a body written from scratch after the last push: that deletes the sections for good, and the squash commit ships without the LOC table.

## Media in the PR body

Include screenshots or short videos whenever visual review helps. reviewers often have no idea the "why" of a change. Even for bugs, before/after videos prove that the problem was real and was fixed. We also like videos because they prove that real code paths were exercised.

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

`gh` (2.99+) uploads it: `--attach <file>` on `gh pr create`, `gh pr edit` and
`gh pr comment` mints the `user-attachments` URL and appends a player to the body.
A body that already references the file (`![demo](./demo.mp4)`) gets that
reference rewritten to the uploaded asset instead, so the video can sit where the
text introduces it. Videos take no `#alt text` suffix (gh refuses it); images do.

```bash
PR_GUIDANCE_HASH=<hash> gh pr create --draft --body-file body.md --attach ./demo.mp4
PR_GUIDANCE_HASH=<hash> gh pr edit <n> --attach ./after.mp4   # appends to the current body
```

GitHub accepts `.webm`, `.mp4` and `.mov`; `ffmpeg -i video-rendered.webm demo.mp4`
gives the widest playback support.

Spec recordings: ship `video-rendered.webm` from `VIDEO_MODE=1 pnpm spec -g <name>`;
[Video mode](testing.md#video-mode-recorded-spec-demos-for-prs) covers the
rendering setup (`ffmpeg-full`) and the output paths.

Verify the player rendered:

```bash
gh api repos/iterate/iterate/pulls/<n> -H "Accept: application/vnd.github.html+json" --jq .body_html | grep -c '<video'
```

`gh pr edit` sometimes fails on this repo (GraphQL classic Projects deprecation). REST works:

```bash
gh api -X PATCH repos/iterate/iterate/pulls/<n> --input payload.json
```

## Previews

Every open PR (draft or ready) whose change touches the platform or its clients gets a preview deployment: the Preview OS workflow deploys one Cloudflare Worker Preview of `apps/os` per PR, plus the Dash, Agents, Notes, Voice and Kit clients on top (**Deploy preview**), runs the integration suite (**E2E tests**) and the browser specs (**Browser specs**) against it, and writes the links and operations into the PR body. E2E tests and Browser specs are required checks. A PR that touches none of the preview paths deploys nothing, and both skip, which counts as passing. Commands for resetting, re-running the suites or deleting the preview: [apps/os/README.md](../apps/os/README.md).

For operational changes, inspect the preview's resulting state and telemetry in addition to test results. Production rollout remains gated on the [engineering invariant](engineering-invariants.md).

## After open — agents landing a PR

These rules apply whenever an agent is asked to open, babysit, address review, or merge a PR. A human may override them explicitly for one PR; do not invent overrides.

### Wait for reviews (especially Cursor Bugbot)

- **Do wait** for **Cursor Bugbot** (and any other review bot that posts threads) to finish before treating the PR as “done,” unless the human says not to.
- Bugbot is done when its check-run reaches `status: completed` (`success`, `skipped` and `neutral` all count); its findings are the unresolved review threads, which must reach zero. Rules 1–3 below say how to poll both.
- Prefer waiting for **Cursor Bugbot** over merging on lint/test green alone.
- The **Iterate GitHub AI linter** check reviews each head of an open, non-draft PR against `rules/` at the PR's base, as `iterate[bot]` (it runs on the prd `iterate` project from iterate/config `ai-linter/`). It is done at `status: completed`: `success` means no findings, and `neutral` means its inline comments are review threads like Bugbot's. It never blocks a merge.

#### Agent wait loops: gate on the head commit's check-runs

Hand-rolled "wait for green" loops (agents babysitting a PR) keep failing the
same three ways. The rules that survive contact:

1. **Poll the head commit's check-runs, never `gh pr checks` text.** Right
   after a push there is a window where the previous head's checks are gone
   and the new head's are not registered yet — a `grep -c pending` gate reads
   that empty moment as "all done" and exits before CI even starts. Ask for
   the checks OF THE COMMIT and require the ones you care about to exist and
   be `completed`:

   ```bash
   HEAD=$(git rev-parse HEAD)
   gh api "repos/iterate/iterate/commits/$HEAD/check-runs?per_page=100" \
     -q '[.check_runs[] | {name, status, conclusion}]'
   ```

2. **Never wait for "Cursor Bugbot posted a review for `<sha>`".** Bugbot
   SKIPS pushes it deems trivial (merge commits especially) — the check ends
   in `skipped` and no review naming that sha ever appears, so a review-body
   gate spins until its iteration cap and then reports hour-stale state.
   Gate on the Bugbot check-run reaching a terminal `status: completed`
   (conclusion `success`/`skipped`/`neutral` all mean "bugbot is done"), and
   read FINDINGS from unresolved review threads, which is also what blocks
   merges:

   ```bash
   gh api graphql -f query='{ repository(owner: "iterate", name: "iterate") {
     pullRequest(number: <pr>) { reviewThreads(first: 60) { nodes { isResolved } } } } }' \
     -q '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length'
   ```

3. **A push obsoletes every running monitor.** A loop started before a push
   waits on answers about a head that no longer exists. Kill it and start a
   fresh one pinned to `git rev-parse HEAD`; print that sha as the loop's
   first line so a stale monitor is recognizable at a glance.

Also know what actually blocks the merge: `gh pr view --json mergeStateStatus`
answers `BLOCKED` (required things missing — the "Required CI" ruleset requires
**Lint and Typecheck / lint-typecheck**, **Test / test**, **Preview OS / E2E
tests** and **Preview OS / Browser specs**; `gh api
repos/iterate/iterate/rulesets/18718115 --jq '.rules'` lists them), `UNSTABLE`
(something failing that is NOT required — Preview OS / Deploy preview, whose
failure turns both suites red anyway, and Preview OS / CI trace are in this
category), or `CLEAN`. A PR whose last push predates a required check has no
run of it: push again (a rebase does) to get one. A wait-for-green loop that treats `UNSTABLE` as
fatal waits forever on a red non-required check. GitHub does not enforce
review-thread resolution on `main`; this doc does.

### Address every review / CI comment

- Treat **inline review threads** (Bugbot, other review bots, humans) as work items. For each:
  1. **Fix** the code if the comment is right, **or**
  2. **Reply** explaining why it does not apply (with a real reason, not a brush-off).
  3. **Resolve** the thread after the fix or the reply.
- **Do not leave threads standing** and merge. Unresolved = not finished.
- “Doesn’t apply” is fine **with a comment**; silent resolve or silent merge is not.

### CI and merge

- **Never merge when required CI is red** unless the human **explicitly** asked to merge despite failures.
- Preview flakiness: investigate; re-run or fix when you can. Do not use a red check as “close enough.”
- If an unrelated flaky or pathologically slow test is quarantined under the
  [testing protocol](./testing.md#flaky-test-quarantine-protocol), the PR body
  must prominently name the skipped test/lane and link its tracking issue. A hidden skip
  is not green CI.
- When the human asks to merge: wait for green CI **and** zero unresolved review threads, then merge (squash unless told otherwise).
- Do not commit, push, open, or merge a PR unless the human asked for that action (or a standing instruction for this session clearly includes it).
