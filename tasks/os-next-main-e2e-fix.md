---
status: in-progress
size: small
---

# Fix OS-Next main e2e failures

Status: diagnosis complete; implementation and validation pending. All four failures reproduce at `5eaa350b0b`; three count the intentionally excluded wake event, and one exposes normalization before event-type validation.

Request: worktreeify the small fix for the main e2e failure introduced by #2651.

- [ ] Preserve the existing invalid-event validation error when schedule normalization receives a non-string type.
- [ ] Strengthen the existing public e2e regression to prove a rejected batch commits nothing.
- [ ] Update the three tally assertions to count wildcard-consumable durable events, excluding `stream/woken`.
- [ ] Verify the affected e2e scenarios, scheduling coverage, required checks, and an isolated preview.
- [ ] Address CI/review feedback and update the draft PR with evidence.

Scope: no scheduling or subscription behavior changes, no production deployment, and no changes to the unrelated Auth + OS Cloudflare HTTP 500.

## Implementation log

- 2026-09-16: main run `kcs3k9drj7` failed four tests on both attempts; a focused rerun reproduced all four. Its parent `1756658881` passed. Production version `5889b246-f918-4553-a0e9-2bc471c3ca2d` matched the failed commit.
- Worktree: `../worktrees/iterate/os-next-main-e2e-fix`; branch: `codex/os-next-main-e2e-fix`.
