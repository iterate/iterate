---
status: in-progress
size: large
branch: fix/playwright-flake-causes
base: a85434f645
---

# Fix the recurring Playwright failures

The targeted fixes are implemented and pushed. Controlled browser regressions pass; larger zero-retry preview batches and the server-error audit are running. Final validation and preview cleanup remain. **Do not open a pull request**; deliver GitHub compare links.

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

- Preview 3 leased as `playwright-flake-causes` until 2026-09-15 10:31 UTC. Entry erase retired old DOs and removed 713 old artifact repos before its bounded GC deadline; remaining inert repos are outside test correctness. Auth, Docs and OS deployed successfully.
- Initial deployment: SDK/source `965cafd3e512bebf885110c0949a259a945bcaba`; OS version `1fc7a42f-f878-4241-a373-c0cf6e5b564c`, Auth `1e460a64-3966-4a18-bbd0-3a07e1a25c9b`, Docs `537fde6e-f142-4168-bbec-a5f738b03403`. Waited 90 seconds after successful deployment before tests.
- Initial batch: 2 repeats of each of seven focused tests, four workers, zero retries. Todo, fake-model multi-turn, script return typing without warm-up, mobile notes, freeze recovery and review each passed twice. The review wrapper recorded actual `pass` twice (no matched flakes). Shopping-list undo failed twice because DOM text offsets included peer-caret labels; remove those decorations when measuring the native selection and assert the selected word before typing.
- Note-race reproduction: analysis re-reads the old body, a user edit commits, then analysis writes the old body back. Replaced unconditional writeback with `Workspace.edit` so its old-text check and write serialize together. Tests also cover deletion and unrelated write errors. Twelve notes tests pass.
- Middlewright upstream branch: https://github.com/iterate/middlewright/compare/main...fix/input-value-loading (`bb18716`). The delayed-composer regression failed before the change, then all 27 spinner/plugin tests, typecheck, build and lint passed. Iterate carries that change as a pnpm patch until upstream release; no upstream PR opened.
- Focused checks: 18 SDK regression tests and 17 OS progress/composer tests passed; specs typecheck and OS TypeScript check passed; changed-file lint passed. SDK-wide `tsc --noEmit` has three pre-existing errors in unchanged auth-contract/CLI code (`Headers` iterable/entries and `NestedClient` typing), not in these changes.
- Raw local evidence: `.flake-validation.ignoreme/initial/` (JSON report, first-failure traces, zero-retry command, flake records), plus worker tail. It is deliberately ignored; retain a concise results table here for review.

- Corrected-batch investigation: a peer edit could arrive between measuring its text offset and selecting the word. Wait for the peer to display the local edit before selecting. Cursor-name decorations also split visible phrases in DOM text; compare rendered document lines with cursor decorations removed. These were defects in the new test, not demonstrated undo failures.
- Todo ordering: the subscription can arrive before the Add response. Allocate the row ID in the browser and send it with Add, so either arrival order retires the same optimistic row. Three DOM regressions cover both orderings and a rejected save; 16 starter-app tests pass.
- Added a real-browser pending-send test: hold client WebSocket frames after initial subscriptions are ready, require Sending before releasing them, hold the fake model response, and verify backend progress takes over before displaying its reply. A trial click establishes readiness before the transport gate; gating during initial setup otherwise deadlocks the test itself.

- Final behavior deployment: SDK/source `cfe9055be60db07554adb1ccc6a7e060f9436e31`, OS `040f7d7a-aeeb-4039-adee-2141d4b6fb62` (uploaded 22:51:50 UTC). Three consecutive runs each of shopping-list undo and controlled Sending passed before the 20-repeat/eight-worker batch.
- The real conditional-edit probe preserved newer file contents and returned the expected stale-edit rejection, but its ITX span/log called it a server error (`log_058f026e58ec41e3892cd4590a064f4f`, trace `ece820338859304f9b23492a65e47314`). Classify only Workspace.edit's missing old text/deleted file as `client_error`; keep transport errors and failures from other methods as errors. The two expected-conflict regressions failed before this change.
- Cloudflare audit found a brief platform reset burst at 22:54:41–47 UTC: internal DO storage resets followed by code-reset errors and eight rejected delivery batches whose preceding batch had been lost. There was no intervening deployment in Cloudflare's history. Recovery checks at 22:57:14–15 showed both affected project subscriptions caught up (100/100 and 94/94), and the affected agent subscription caught up (151/151), all active with no pending retry or last error. These are shared reset/recovery observations, not evidence that this branch fixes Cloudflare storage resets.
