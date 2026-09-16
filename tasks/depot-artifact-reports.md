---
status: in-progress
size: medium
---

# Publish Playwright HTML reports through Depot artifacts

Spec committed; CI wiring and live proof remain. Companion config-repo work generalizes the existing artifact viewer.

## Request and decisions

Publish the merged Playwright HTML report through the generic Depot artifact viewer. Artifact roots open index.html, redirect a sole file, or show a generated listing. Use the existing upload mechanism and commit-status style; do not commit generated files.

- Upload the finished HTML report directory separately as `public-playwright-report`. Keep raw runner artifacts separate.
- Publish a `Playwright report` commit status whose external URL opens the report, including failed-test reports when produced. Report availability is distinct from the existing test outcome check.
- Resolve the artifact through Depot's current workflow and attempt identity, not the Actions upload action's numeric artifact ID. Do not let old runs replace newer commit-status links.
- Keep changes small and reuse existing CI coordination/publication where useful. Keep trace publication working when the config viewer becomes generic.
- Coordinate rollout with a linked config PR. Do not merge either PR automatically.

## Acceptance

- [ ] Add and validate report upload/link steps after merging shard results, including test failures.
- [ ] Preserve trace report entry links under generic artifact root behavior.
- [ ] Verify a real Depot artifact and browser report, including assets/attachments.
- [ ] Run relevant checks, capture visual proof, update PR descriptions and handle review feedback.

## Implementation log

Codex task: `01a0ac05-514e-78c0-b5ed-877ab8edfaa9`.
