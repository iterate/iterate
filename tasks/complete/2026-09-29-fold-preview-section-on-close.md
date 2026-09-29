---
size: small
---

# Fold the PR body's preview section when the PR closes

Status: done. The close's delete folds the section as "Deleted deployment"; PR #3438.

Closing a PR deletes its preview deployments (preview-delete.yml, `pnpm preview delete`), but the PR body's `os-preview` section keeps linking to them: every link in a closed PR's body is dead.

A push already folds the section into a `<details>` ("Previous commit's deployment") before the next deploy replaces it. Closing should fold it the same way; nothing replaces it.

- [x] `pnpm preview delete --pr <n>` folds the section before deleting, summary `Deleted deployment: <code>pr<n>-<sha7></code>` _`deletePrefix` in apps/os/scripts/preview.ts_
- [x] one fold function with the summary label as a parameter, shared with the deploy's fold _`foldPreviewSection(body, label)` in preview-config.ts, was `foldPreviousPreviewSection`_
- [x] a body write that fails is logged, never the delete's failure (same as the deploy) _`.catch` → `console.warn`_
- [x] preview-delete.yml gets `pull-requests: write` and the GitHub token _plus `GITHUB_REPOSITORY`; depot-workflows.test.ts permissions row updated_
- [x] a section already folded (the last push's deploy failed) stays as it is; its links are hidden, which is enough _`foldPreviewSection` leaves a `<details>` section alone_
- [x] docs/dev-environments.md says the close folds it

## Implementation notes

- Not seen on a real close yet: preview-delete.yml runs from the closing commit's tree, so the first PR merged after this one is the first real run.
