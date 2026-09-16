---
status: in-progress
size: small
---

# Fix OS-Next main e2e failures

Status: fix implemented; all four original failures pass locally. Broader checks, deployed preview proof, and PR review remain.

Request: worktreeify the small fix for the main e2e failure introduced by #2651.

- [x] Preserve the existing invalid-event validation error when schedule normalization receives a non-string type. *`normalizeControlEvent` only inspects the schedule prefix for string types; `Stream.append` still owns validation.*
- [x] Strengthen the existing public e2e regression to prove a rejected batch commits nothing. *The stream e2e tries eight invalid types in mixed batches and checks the complete durable log remains unchanged.*
- [x] Update the three tally assertions to count wildcard-consumable durable events, excluding `stream/woken`. *Both tally helpers now express wildcard counts independently of the product filter.*
- [ ] Verify the affected e2e scenarios, scheduling coverage, required checks, and an isolated preview.
- [ ] Address CI/review feedback and update the draft PR with evidence.

Scope: no scheduling or subscription behavior changes, no production deployment, and no changes to the unrelated Auth + OS Cloudflare HTTP 500.

## Implementation log

- 2026-09-16: main run `kcs3k9drj7` failed four tests on both attempts; a focused rerun reproduced all four. Its parent `1756658881` passed. Production version `5889b246-f918-4553-a0e9-2bc471c3ca2d` matched the failed commit.
- Worktree: `../worktrees/iterate/os-next-main-e2e-fix`; branch: `codex/os-next-main-e2e-fix`.
- The strengthened public regression failed with the original TypeError before the fix; the focused rerun passed all four original failures after it (32.4 seconds, including builds).
