# Pull requests

How agents and humans should open PRs in this monorepo. Keep this short; link out for CI/preview details.

## Before you open one

From the repo root (or the app you touched):

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

Scope the PR to one outcome. Prefer a clean branch off `origin/main` — do not stack unrelated WIP from a long-lived worktree branch into the PR.

## Branch, commit, push

```bash
git fetch origin main
git checkout -B <short-descriptive-branch> origin/main
# …commit only the files for this change…
git push -u origin HEAD
gh pr create --title "…" --body-file /tmp/pr-body.md
```

Commit messages: complete sentences, what + why. Do not commit, push, or open a PR unless the user asked.

## PR body

Write a real summary (what changed, why), a test plan with checkboxes, and screenshots or a short video when the change is visual.

Bots maintain managed blocks in the body (`loc-report`, preview lease, Cursor summary). When editing an existing PR description:

- Prefer a surgical replace of the human-written section.
- If you must rewrite the whole body, preserve those managed HTML comments / sections, or use the REST API (`gh api -X PATCH repos/iterate/iterate/pulls/<n>`) rather than `gh pr edit` when GraphQL fails.

`gh pr edit` sometimes fails on this repo with a GraphQL `projectCards` / classic Projects deprecation error even though the body is fine. REST works:

```bash
gh api -X PATCH repos/iterate/iterate/pulls/<n> --input /tmp/pr-payload.json
# payload: { "body": "…" }
```

## Screenshots and other media

### What went wrong (learned on #1994)

Relative repo paths in the PR body **do not render**:

```markdown
<!-- BROKEN in a PR description — looks fine in a README on a branch -->

![Link form](docs/pr-assets/github-history-resolution/01-link-form-pull-first.png)
```

GitHub does not resolve those paths against the PR head the way it does for files in the tree browser. Reviewers see a broken image icon.

### What works

1. **Commit the assets** under something stable like `docs/pr-assets/<feature>/…` (keeps them reviewable in the diff and re-usable after merge).
2. **Reference them with an absolute URL** that points at the **branch** (or a specific commit SHA):

```markdown
![Link form](https://github.com/iterate/iterate/raw/<branch>/docs/pr-assets/<feature>/01-….png)
```

Equivalent form that also works:

```markdown
![…](https://raw.githubusercontent.com/iterate/iterate/<branch-or-sha>/docs/pr-assets/…/01-….png)
```

Prior art: agents-stream-ui PR used `https://github.com/iterate/iterate/raw/<branch>/docs/pr-assets/…`.

3. After push, **smoke-check** the URL returns 200:

```bash
curl -sI -o /dev/null -w "%{http_code}\n" -L \
  "https://github.com/iterate/iterate/raw/<branch>/docs/pr-assets/<feature>/01-….png"
```

### Alternatives

| Approach                                                  | When                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Absolute `github.com/.../raw/<branch>/…` (preferred here) | Images committed on the PR branch                                                                              |
| Absolute `raw.githubusercontent.com/.../<sha>/…`          | Pin to one commit so renames/force-pushes do not break old comments                                            |
| `https://github.com/user-attachments/assets/…`            | Uploaded through the GitHub UI / comment attachment flow (also required for **video** that should play inline) |

Do **not** rely on relative paths in PR/issue bodies. Relative paths are fine in `README.md` and other in-repo markdown that GitHub renders from a tree path.

### Capturing shots

- Prefer a real UI capture when the app is runnable (agent-browser headed session — see [Browser testing](./browser-testing.md)).
- UI-faithful static HTML mocks + Playwright screenshots are OK for a tight sidebar/dialog when spinning the full app is disproportionate — label them as mocks if they are not production captures.
- Keep panels readable at 2× DPR; crop to the control under review.

## Drafts and previews

- **Draft PRs do not get a preview deployment** (or preview e2e) unless you add the `preview` label or mark the PR ready for review.
- Preview lease model: [Dev environments](./dev-environments.md).
- Preview CI budget: [Preview CI performance](./ci-preview-performance.md).

## After open

- Watch CI; fix failures on the same branch.
- Do not force-push over shared history without asking.
- Update the PR body if the outcome changes; keep screenshots in sync with the UI.

## Checklist

- [ ] Clean branch from `origin/main` (no unrelated worktree commits)
- [ ] Title describes the outcome
- [ ] Summary + test plan in the body
- [ ] Visual changes have **absolute** image URLs that return 200
- [ ] `pnpm typecheck` / lint / format / tests green for the touched surface
- [ ] Draft vs ready deliberate (preview lease implications)
