---
status: complete
size: large
branch: fix/playwright-flake-causes
base: a85434f645
---

# Fix the recurring Playwright failures

The requested review amendments are implemented and pushed. The OS UI diff is one Stop-button attribute; Todo is back in its original file; the requested tests/helper are removed; Middlewright comes from pkg.pr.new. Across 206 zero-retry preview attempts, 201 actually passed, one hit the known Docs table flake, and four failed during startup/auth. Notes separately passed 24/24 at four workers. Those failures and backend telemetry findings remain recorded in `tasks/preview-stream-startup-stalls.md`; this is not a claim that all flakes are fixed. The `Workspace.edit` classification implementation is unchanged. Preview 3 was erased and released. **No pull request was opened**; review through the compare links below.

## Review amendments

- [x] Apply the requested UI/test simplifications. *Stop button annotation, Todo restored to `client.tsx`, requested tests removed, dedent lists and native double-click word edits.*
- [x] Replace the Middlewright patch with a commit-pinned pkg.pr.new build. *Published `e3f2374`; no local patch remains. Temporary publication triggers removed from both branches. Frozen install and specs typecheck passed.*
- [x] Revalidate the existing scenarios with zero retries on a fresh preview; erase/release it afterwards. *Traced 14-run sample, 168-run stress batch, and 24 focused Notes runs. Full outcomes below; preview cleanup and release confirmed.*
- [x] Recommend a structured conflict outcome without changing the current classification implementation. *Typed not-applied result at Workspace; Notes records superseded. Recommendation below; implementation untouched.*

## Previous validation (before review amendments)

Local Chromium against leased Cloudflare preview 3; each repetition creates a new project. Shared deployment/assets can be warm. Test head `8b7f9ebdb`; deployed SDK/source `dac4f9f2e280e01c8d4d70a88251e2f64dbacdd9`; OS version `cb1ea6cf-25d9-4ef5-82af-3b689e24bde3`. Later documentation/cleanup commits do not change the deployed product. The complete batch took 4.9 minutes at 16 workers, with `--repeat-each=24 --retries=0 --fully-parallel`.

| Scenario | Actual passes | Median / maximum seconds |
| --- | --- | --- |
| Seeded Todo | 24/24 | 14.0 / 16.8 |
| Fake-model three-turn chat | 24/24 | 19.6 / 26.6 |
| Local Sending → backend progress | 24/24 | 15.2 / 20.8 |
| Script return typing, without warm-up agent | 24/24 | 21.4 / 26.0 |
| Shopping-list collaborative undo | 24/24 | 16.4 / 20.8 |
| Remaining Docs review | 24/24 | 22.8 / 29.0 |
| Freeze + socket recovery | 24/24 | 13.1 / 16.7 |
| Mobile notes | 24/24 | 27.2 / 35.8 |

Durations include project/bootstrap work. The Docs wrapper recorded **24 `pass`, zero `flake-fail`, zero `unexpected-error`**. Its expected-failure display does not mean those bodies failed. Known review-only failures remain narrowly quarantined as requested; undo is a normal test. The independent 40-repeat freeze batch passed 40/40 at eight workers (median 14.2s, maximum 18.2s). The fully traced eight-worker sample passed 16/16. Earlier failed/interrupted batches remain recorded below, not replaced by the final green batch.

Focused static/regression checks: 21 SDK tests, 34 OS tests, OS/specs typechecks and changed-file lint passed. Middlewright's 28 spinner/plugin tests passed; the three new scenarios also passed ten repetitions each (30/30), plus typecheck/build/lint. The SDK-wide typecheck still has the three pre-existing errors listed below.

## Request and assumptions

Fix the six failure groups investigated in the CI design jam, with repeated individual tests against a leased preview. Commit this specification first, then commit and push meaningful changes and findings as the investigation proceeds. Keep ordinary retries configured for now; all acceptance reruns use zero retries. Leave the root worktree and the separate CI readiness work untouched.

- [x] Seeded todo: display an optimistic item immediately, with `data-spinner` until the server's subscribed state confirms it. Test confirmation/persistence, not just optimistic rendering. *Optimistic row and stable ID in the original `client.tsx`; real Todo spec verifies confirmation and persistence. Review removed the component extraction and its unit tests.*
- [x] Fake-model multi-turn and script return typing: mark the existing pending-send/Stop UI immediately, then maintain visible progress through backend acceptance, execution and displayed results. Investigate remaining real delays separately from progress gaps. Reuse existing OS/mobile behavior where appropriate. *The existing Stop button carries `data-spinner`; the separate Sending status and dedicated loading-state test were removed during review. Existing multi-turn/script specs provide coverage.*
- [x] Remove the script test's warm-up agent if the real behavior passes without it; do not swallow warm-up failures or replace it with sleeps. *Removed from `specs/agent-script-reuse.spec.ts`; cold tests pass without swallowed work.*
- [x] Docs: isolate collaborative undo. Start with green apples, crunchy peanut butter and bananas; local changes green to red, peer changes crunchy to smooth; positively wait for both; undo locally; positively wait for green and smooth, then assert no red. Verify the saved document. Move remaining review behaviors into a separate test and record their specific known failures with `createFlake`. *Separate shopping-list spec verifies both editors and exact saved file. Review-only patterns remain measured.*
- [x] Mobile notes: add Middlewright support for `inputValue` loading waits. Fix stale note text passed into chat, preserving acknowledged edits. Check the navigation stalls independently. *Published Middlewright build handles `inputValue`; notes analysis now conditionally edits the exact contents, preserving newer edits/deletion.*
- [x] Freeze/socket recovery: test the current pause/resume stimulus. If the specific event-recovery failure persists, use a narrow `createFlake` with recorded evidence; unrelated setup/transport failures remain failures. *Current stimulus passed 40 focused and 24 final mixed runs; the two startup failures remain red and are documented separately.*
- [x] Add focused regression coverage for product fixes and run relevant static checks. *Focused SDK/OS tests, typechecks and lint passed; upstream Middlewright regression coverage also passed.*
- [x] Lease a preview without creating a PR; deploy the relevant apps and confirm readiness before focused tests. *Leased preview 3 and deployed Auth, Docs and OS; waited for the shared deployment delay outside the reruns.*
- [x] Run at least 20 independent zero-retry repetitions of each affected test on the final relevant code, with controlled parallel batches. Record actual passes, known flakes, failures, timings, commit and deployment identity. Investigate every unexpected failure; repeated green alone is evidence, not proof of zero flake probability. *24 actual passes per scenario in the final 192-run batch, zero retries; earlier failures and all recorded outcomes retained.*
- [x] Inspect relevant preview errors/traces for any unexplained product failures, clean up test projects and release the lease when finished. *Audit and remaining errors documented; nine DO classes retired, Auth D1/KV erased, bounded artifacts GC completed, lease released.*
- [x] Push all work and provide the compare link with a concise account of validation and any explicit coverage debt. *Both branches pushed; compare links below. No PRs opened.*

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

- First large batch: **159/160 passed**, 20 repetitions per scenario, eight workers, zero test retries. The seven other scenarios passed 20/20 each; review passed 19/20 with one unexpected reload/readiness failure. Its trace showed the live badge appeared between Middlewright's readiness check and loading check, but it still invoked the final action with a 1ms timeout. Reproduced in Middlewright by completing a real DOM update during the loading query; the ready button could not be clicked under 1ms. Recheck readiness after observing no loading, preserving the normal action budget only when the control is already ready. All 28 upstream spinner/plugin tests pass, including unchanged fail-fast and explicit-timeout checks. Carry this second fix in the same pnpm patch.
- First large batch durations (including each test's project/bootstrap work): median/max seconds: todo 16.7/28.8; fake chat 21.4/40.2; Sending handoff 18.0/34.2; cold script typing 25.1/52.1; undo 17.8/22.6; review 26.2/33.6; freeze 16.1/24.4; mobile notes 20.3/25.2. No whole-test retries were used.

- With the readiness recheck applied, Docs review passed 20/20 focused preview runs at eight workers (all real passes, no matched flakes). Each of the three new Middlewright scenarios also passed ten repetitions: 30/30, zero retries. Shortening the local flake registration name keeps the existing review body at its original indentation, so the compare diff shows the meaningful changes.
- Mobile already has `PendingSendBubble` with a local “sending…” working card (`apps/mobile/src/app/project/[projectId]/chat.tsx`). OS already had `useStreamSubmission` and backend/feed acknowledgement tracking; the missing piece was independent visible text when the composer button switches to Stop. The added Sending status reuses that existing pending state.

- Final product deployment: SDK/source `dac4f9f2e280e01c8d4d70a88251e2f64dbacdd9`, OS `cb1ea6cf-25d9-4ef5-82af-3b689e24bde3`. Both real conditional-edit probes now have `client_error` outcomes and info-level spans, while preserving the newer edit/deletion: trace `50573400e673b4e3a80155756510c64c`, calls `log_64f7dda9fa694c75b71d47e17b4e1ad4` and `log_fb8332101fe149549d832dd672b3b54a`.
- Full-trace sample on that deployment: 16/16 passed at eight workers. Fake-model project creation took 12.25/12.92 seconds; the six individual Send-to-visible-reply intervals were 2.87–3.42 seconds. No warm-up agent or whole-test retry. This sample separates setup cost from model-turn latency; it does not explain every historical slow run.
- First 16-worker stress batch stopped after two failures: 77 actual passes, two failures, 15 interrupted, 146 not run. All 12 completed review bodies passed. Both failures were before the freeze stimulus: an agent-creation keyed append got no response within its existing 10-second bound; another browser missed the baseline within 30 seconds. That browser's mirror was still `connecting`, with a client but no event connection or delivered events. The server had published the baseline at offset 51 and its feed was caught up. Its SQLite WASM request had HTTP 200 headers but no completed body in the trace; all 16 successful traced runs had complete WASM downloads. This points to asset/bootstrap delivery, not a demonstrated freeze-recovery regression. These failures remain red; neither the allowed Docs pattern nor test timeouts were broadened.
- Final batch telemetry: 134 error-labelled records, comprising 100 records across 25 network-closure traces (this suite deliberately closes sockets), 31 native HTTP 503 records during cold Docs worker builds, and three registry alarm-arming errors. No ITX server-error record appeared in this batch. The alarm-arming errors remain investigation debt in `tasks/preview-stream-startup-stalls.md`; green tests do not establish that they are harmless. The real stale-edit/deletion probes separately proved the new `client_error` classification.
- The previously affected repository's `repo` and `feed` subscriptions were also checked after the storage-reset burst: both caught up to offset 25, lag zero, active, no retry or last error. This verifies recovery of the inspected streams, not all platform recovery behavior.
- Removed the temporary branch push trigger from `pkg-pr-new.yml` after publishing the exact SDK tarballs used by the preview. The final workflow matches the original. No PR was opened in either repository.

## Handoff

- Iterate: https://github.com/iterate/iterate/compare/main...fix/playwright-flake-causes
- Middlewright: https://github.com/iterate/middlewright/compare/main...fix/input-value-loading

Preview exit cleanup succeeded: nine non-container DO classes retired, 1,276 KV keys deleted, Auth D1 data erased. Artifacts GC deleted 733 repos before its 90-second deadline; remaining repos are inert and the next pass continues. R2 files and sandbox backups have three-hour expiry. Preview 3 was released after cleanup; its OS worker remains parked until the next owner deploys.


## Review amendment validation log

- Product SDK `e165a68cbff4ff9c2568b1f0273e0f2b6c04a264`; preview SDK ref `e165a68cb`. OS version `9bfe9dab-7752-4f34-a5fa-844de6c1d644`; Docs `0be6147e-36cd-4532-b3d0-8a7d666517a3`. Fresh manual preview-3 lease after entry erasure. Test head `dadd42f98` consumes Middlewright `e3f2374`.
- Local checks: 18 existing SDK/Notes/Todo tests, 14 remaining ITX observability tests, OS/specs typechecks and changed-file lint passed. New Middlewright package passed frozen installation and specs typecheck.
- Middlewright upstream CI completed successfully: 159 tests passed initially, one video cursor-tail test passed on retry, three skipped. This is not a zero-retry upstream run. Its failure was the existing `video-mode-ffmpeg.spec.ts` pointer-tail check, separate from spinner/inputValue coverage. The package also includes main's existing cursor-expression fix (#43), the only product-code difference from the old package beyond this branch's spinner/inputValue fixes.

- Recommendation left for discussion: model a rejected conditional edit at the Workspace boundary as a typed `not-applied` result (changed/deleted), which Notes records as `superseded`. Throw actual storage/transport faults. This removes both Notes' message matching and telemetry's method/message matching; no special `client_error` rule is needed for an ordinary race. This is a public API decision, not implemented in this branch. The current observability implementation is unchanged by the review amendments.

- Review traced sample: **14/14 actual passes**, two per scenario at eight workers, zero retries. The OS audit had 20 records across five connection-closure traces and seven cold-build HTTP 503 records; no ITX server errors in this sample.
- Review stress batch: **163 actual passes, one known Docs table flake, four ordinary failures**, 168 attempts at 16 workers, zero retries (6.1 minutes). Todo, fake-model multi-turn, shopping-list undo and freeze each passed 24/24. Script reuse passed 23/24; the failure was before first send, stuck on Initializing agent with an uncompleted WASM response. Notes passed 21/24; the three failures were in auth fixture setup with HTTP 429s, before Notes. Review passed 23/24 with the one specifically allowed Approved-table timeout. These outcomes are retained, not overwritten by later runs.
- Full SDK typecheck exposed a UUID-inferred parameter type in Todo; explicit `id: string` fixes it without changing emitted JavaScript. Commit `050d7bf8f`. Full SDK typecheck and worker lint then passed. The earlier historical SDK diagnostics are not present in this checkout's final typecheck.
- Stress telemetry: 128 error-labelled records: 95 connection-closure records (24 traces), 25 native cold-build 503 records, five registry alarm-arming errors, two `LiveStateRelay.subscribe` errors and one hosted repository processor acknowledgement timeout. The latter findings and the confirmed repository recovery are recorded in `tasks/preview-stream-startup-stalls.md`; no claim that this branch resolves them.

- Separate Notes run: **24/24 passed**, four workers, zero retries, 2.9 minutes (median 24.7s, maximum 37.6s). No error-labelled OS telemetry records in that run. This supplies focused Notes evidence without dismissing the mixed run's OAuth rate-limit failures.

- Review exit cleanup succeeded: nine non-container DO classes retired, 602 Auth users/250 organizations cleared, 458 KV keys removed. Artifact GC deleted 665 repositories before its 90-second budget; remaining inert repositories await the next pass. File/backup buckets retain the three-hour expiry policy. Preview-3 lease `f1cc0b0f-a961-4b06-bca7-7f5d43312f99` was released (`released: true`).
