---
status: complete
size: small
---

# Fix OS-Next main e2e failures

Status: complete. The product fix landed independently in #2666 and is merged here unchanged. This PR keeps the stronger public regression, with eight unrolled invalid-batch cases. Preview proof and review changes are complete; CI/review monitoring remains active.

Request: worktreeify the small fix for the main e2e failure introduced by #2651.

- [x] Preserve the existing invalid-event validation error when schedule normalization receives a non-string type. *#2666 landed the fix during verification; this branch takes its implementation unchanged.*
- [x] Strengthen the existing public e2e regression to prove a rejected batch commits nothing. *The stream e2e tries eight invalid types in mixed batches and checks the complete durable log remains unchanged.*
- [x] Update the three tally assertions to count wildcard-consumable durable events, excluding `stream/woken`. *#2666 landed both corrected tally helpers; this branch takes them unchanged.*
- [x] Verify the affected e2e scenarios, scheduling coverage, required checks, and an isolated preview. *All four original failures pass; the merged preview ran 48 passing tests with one unrelated schedule-test race, then both that test and the unrolled regression passed in isolation. Typecheck, knip, formatting, focused lint and CI passed.*
- [x] Address CI/review feedback and update the draft PR with evidence. *Unrolled all eight cases per Misha's review; #2665 now describes only the remaining regression coverage, with global PR monitoring registered.*

Scope: no scheduling or subscription behavior changes, no production deployment, and no changes to the unrelated Auth + OS Cloudflare HTTP 500.

## Implementation log

- 2026-09-16: main run `kcs3k9drj7` failed four tests on both attempts; a focused rerun reproduced all four. Its parent `1756658881` passed. Production version `5889b246-f918-4553-a0e9-2bc471c3ca2d` matched the failed commit.
- Worktree: `../worktrees/iterate/os-next-main-e2e-fix`; branch: `codex/os-next-main-e2e-fix`.
- The strengthened public regression failed with the original TypeError before the fix; the focused rerun passed all four original failures after it (32.4 seconds, including builds).
- #2666 landed independently while this PR was under validation. Merged main without rewriting history; removed duplicate product/tally changes.
- Final preview version: `aca1c174-68c7-4556-b389-783966061dfd` on OS-Next `preview_2`. Four smoke probes passed. Captured 611 invocations with zero exceptions or warning/error logs.
- Node 26's client failed the unchanged 5 MB WebSocket test on both main and preview; the exact test passed with `.nvmrc`'s Node 24.4.1. No runtime workaround added.
- Final broad preview run: 48 passed, one opt-in skip, and the existing schedule pause race documented in `tasks/os-next-schedule-pause-test-race.md`. An isolated rerun passed both the pause test and the final unrolled regression (8.05 seconds total).
- Full CI passed on `ef905d334`; Depot test and lint/typecheck jobs also finished successfully on merged head `e0b6476de`. Local full lint separately hit an unrelated `git blame` timeout in its plugin; focused lint and CI lint passed.
