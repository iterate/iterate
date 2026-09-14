---
status: in-progress
size: large
branch: fix/playwright-flake-causes
base: a85434f645
---

# Fix the recurring Playwright failures

Worktree and scope prepared. Implementation and preview reruns remain. The deliverable is a pushed branch and GitHub compare link; **do not open a pull request**.

## Request and assumptions

Fix the six failure groups investigated in the CI design jam, with repeated individual tests against a leased preview. Commit this specification first, then commit and push meaningful changes and findings as the investigation proceeds. Keep ordinary retries configured for now; all acceptance reruns use zero retries. Leave the root worktree and the separate CI readiness work untouched.

- [ ] Seeded todo: display an optimistic item immediately, with `data-spinner` until the server's subscribed state confirms it. Test confirmation/persistence, not just optimistic rendering.
- [ ] Fake-model multi-turn and script return typing: show local Sending immediately, then maintain visible progress through backend acceptance, execution and displayed results. Investigate remaining real delays separately from progress gaps. Reuse existing OS/mobile behavior where appropriate.
- [ ] Remove the script test's warm-up agent if the real behavior passes without it; do not swallow warm-up failures or replace it with sleeps.
- [ ] Docs: isolate collaborative undo. Start with green apples, crunchy peanut butter and bananas; local changes green to red, peer changes crunchy to smooth; positively wait for both; undo locally; positively wait for green and smooth, then assert no red. Verify the saved document. Move remaining review behaviors into a separate test and record their specific known failures with `createFlake`.
- [ ] Mobile notes: add Middlewright support for `inputValue` loading waits. Fix stale note text passed into chat, preserving acknowledged edits. Check the navigation stalls independently.
- [ ] Freeze/socket recovery: test the current pause/resume stimulus. If the specific event-recovery failure persists, use a narrow `createFlake` with recorded evidence; unrelated setup/transport failures remain failures.
- [ ] Add focused regression coverage for product fixes and run relevant static checks.
- [ ] Lease a preview without creating a PR; deploy the relevant apps and confirm readiness before focused tests.
- [ ] Run at least 20 independent zero-retry repetitions of each affected test on the final relevant code, with controlled parallel batches. Record actual passes, known flakes, failures, timings, commit and deployment identity. Investigate every unexpected failure; repeated green alone is evidence, not proof of zero flake probability.
- [ ] Inspect relevant preview errors/traces for any unexplained product failures, clean up test projects and release the lease when finished.
- [ ] Push all work and provide the compare link with a concise account of validation and any explicit coverage debt.

## Evidence and implementation log

- Historical evidence: root worktree `explainers.ignoreme/ci-design-jam/retry-causes.md` and `evidence/retry-first-failures.json`; 75 first failures across 61 attempts, September 8–14. Some failures predate fixes, especially mobile composer waits and the freeze stimulus. Do not count those as current defects without verification.
- Ranked working hypotheses: (1) local submission state ends before backend progress or feed rendering begins; (2) UI assertions mistake optimistic state for a persisted edit; (3) older browser/harness APIs do not honor loading or accurately simulate suspension; (4) genuine backend/transport stalls remain and require separate timing evidence.
- User approved initial likely fixes before preview iteration. Use deterministic delayed-operation coverage where practical, then test the original flows against the real deployed system.
