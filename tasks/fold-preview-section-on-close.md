---
size: small
---

# Fold the PR body's preview section when the PR closes

Status: specced, not started.

Closing a PR deletes its preview deployments (preview-delete.yml, `pnpm preview delete`), but the PR body's `os-preview` section keeps linking to them: every link in a closed PR's body is dead.

A push already folds the section into a `<details>` ("Previous commit's deployment") before the next deploy replaces it. Closing should fold it the same way; nothing replaces it.

- [ ] `pnpm preview delete --pr <n>` folds the section before deleting, summary `Deleted deployment: <code>pr<n>-<sha7></code>`
- [ ] one fold function with the summary label as a parameter, shared with the deploy's fold
- [ ] a body write that fails is logged, never the delete's failure (same as the deploy)
- [ ] preview-delete.yml gets `pull-requests: write` and the GitHub token
- [ ] a section already folded (the last push's deploy failed) stays as it is; its links are hidden, which is enough
- [ ] docs/dev-environments.md says the close folds it
