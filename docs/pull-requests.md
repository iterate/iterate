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
