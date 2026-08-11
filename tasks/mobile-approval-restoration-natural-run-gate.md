---
status: in-progress
size: medium
---

# Monitor the restored mobile approval flows for 25 natural previews

Status: 18/25 qualifying post-merge natural canonical preview occurrences are queryable. The restored approval and notification specs passed first attempt in all eighteen; seven natural occurrences remain. Eleven post-merge natural runs are excluded and classified below: seven failed both targets because the Notifications drawer entry was absent, one target notification spec retried after preview auth returned HTTP 429, and three had unrelated stream-fence failures. Two other finished post-merge workflows explicitly skipped both targets and are not occurrences. The corrected stream quiet-window fence passed first attempt in two canonical previews. No excluded run left incomplete telemetry.

- [x] Define the post-merge gate from durable telemetry. *A qualifying occurrence is a normally triggered canonical preview workflow with both restored specs passed, `retry_count = 0`, `passed_after_retry = false`, and one complete non-failed telemetry finalizer.*
- [x] Preserve the accepted baseline evidence. *Workflows `497719938401885`, `105920886681524`, and `114044928448857` are queryable qualifying occurrences.*
- [x] Count the first natural occurrence after the telemetry delivery diagnosis. *Workflow `294834303475777` was triggered by the normal #2470 push, passed both restored specs first attempt, and has a complete 10-artifact / 7,832-runner-event finalizer.*
- [x] Count the first natural occurrence after propagating #2467's completed trace proof. *Workflow `454307980408418` was triggered by the normal #2470 push, passed both restored specs first attempt, and has a complete 10-artifact / 7,664-runner-event finalizer.*
- [x] Count the parallel natural #2467 occurrence. *Workflow `160813051357004` passed both restored specs first attempt, had no failed or retried test, and has a complete 10-artifact / 7,814-runner-event finalizer.*
- [x] Count the natural #2467 occurrence after the merge-forward. *Workflow `81253986898872` passed both restored specs first attempt with `retry_count = 0` and `passed_after_retry = false`; retained telemetry replay produced a queryable complete 10-artifact / 7,942-runner-event finalizer.*
- [x] Classify the excluded stream-idle failures. *Workflow `278234786942377` passed both restored specs first attempt but failed an unrelated stream quiet-window assertion twice. Exact-version traces show the test's final `getEvents` observation cold-booted the Stream and wrote the reported `woken` fact; no invocation touched that object during the preceding quiet window. Commit `2231c91dc` added a durable boot barrier and bounded cross-clock observation margin. Natural proof workflows `223122126291692` and `440009111509530` again passed both restored targets first attempt, but correctly remained red because the barrier's own short-lived `waitForEvent` session facts were anchored inside the quiet window. Commit `921cfc4b8` moves the anchor past all barrier-owned lifecycle facts.*
- [x] Count the corrected fence's natural #2470 proof. *Workflow `204202074715153` passed both restored specs first attempt and has a complete 10-artifact / 8,003-runner-event finalizer. The corrected stream spec also passed first attempt.*
- [x] Count the corrected fence's natural #2467 proof. *Workflow `476025826996334` passed both restored specs first attempt and has a complete 10-artifact / 7,893-runner-event finalizer. The corrected stream spec also passed first attempt.*
- [x] Count the overlapping natural #2473 preview. *Depot run `8q04w5ncq1` records a normal `pull_request` trigger. Retained workflow `171901776700561` had both restored specs clean, no failed or retried test anywhere, and a complete 8-artifact / 6,650-runner-event finalizer.*
- [x] Classify the excluded target retry. *Natural workflow `274645031538687` predated #2470. Its notification spec's first attempt received HTTP 429 from preview auth's fixed-code OTP endpoint (CF-Ray `a2901dc1b807f6c0-IAD`), then passed on the single framework retry. #2470 raises only the preview/test-lane OTP limit, and later natural occurrences are clean.*
- [x] Count the natural #2469 preview. *Depot run `gwzq58bvf4` records a normal `pull_request` trigger. Retained workflow `293927096273794` had both restored specs clean, no failed or retried test anywhere, and a complete 8-artifact / 6,487-runner-event finalizer.*
- [x] Count three earlier retained natural previews. *Workflows `263677043387377`, `140816095847378`, and `368039917139070` had both restored targets clean and complete non-failed 8-artifact finalizers. Their single unrelated retries are classified below.*
- [x] Classify the excluded pre-#2472 target failures. *Natural workflow `417415455450839` failed both restored targets after retry because the Notifications drawer entry was absent. #2472 restored the product's `/notifications` entry point one minute after this run started; every later counted occurrence is clean.*
- [x] Enforce the post-merge boundary. *PR #2460 merged at `2026-08-10T14:23:36Z`; three clean retained workflows that started before that instant were removed from the counter.*
- [x] Count two earlier retained post-merge previews. *Workflows `468072880416234` and `113365974235070` had both restored targets clean and complete non-failed finalizers. One unrelated retry is classified below.*
- [x] Audit the post-merge gap before the first accepted baseline. *Six workflows failed both targets on the missing Notifications entry point, one finished workflow skipped both targets, and cancelled workflows produced no target artifact. No additional clean occurrence was missed.*
- [x] Count the newest natural #2473 preview. *Depot run `6tp7nl5v0j` records a normal `pull_request` trigger. Workflow `134965373738416` had both restored targets clean, no failed or retried test anywhere, and a complete 8-artifact / 6,795-runner-event finalizer.*
- [x] Audit the skipped natural #2376 preview. *Depot run `s15mp7hfh8` records a normal `pull_request` trigger. Workflow `473171817387158` explicitly skipped both restored targets, so it is not an occurrence. Its complete 11-artifact / 7,312-runner-event finalizer exposed three unrelated retries, all classified below.*
- [x] Count the next natural #2473 preview. *Depot run `twfx4x35nt` records a normal `pull_request` trigger. Workflow `510094541966125` had both restored targets clean, no failed or retried test anywhere, and a complete 8-artifact / 6,576-runner-event finalizer.*
- [ ] Observe 7 more qualifying natural canonical preview occurrences.
- [ ] Investigate any target retry, failure, incomplete finalizer, or missing-transition diagnostic before allowing the streak to continue.
- [ ] Record the final 25-workflow evidence set and close the restoration goal.

## Gate rules

- Manual `workflow_dispatch` validation proves a candidate but does not increase the counter.
- The workflow must start after PR #2460's merge at `2026-08-10T14:23:36Z`. Earlier branch previews are pre-merge evidence, not post-merge occurrences.
- Retained telemetry from a naturally triggered run may be replayed idempotently when the runner predated the default-delivery fix; the trigger remains natural.
- A target retry or failure does not count and must be classified. Do not hide it with a timeout increase, a skip, or another retry layer.
- An incomplete or absent finalizer is a telemetry defect, not a clean occurrence.

## Evidence log

| count | workflow | head | PR | evidence |
| ---: | --- | --- | ---: | --- |
| 1 | `468072880416234` | `67168d04` | #2467 | both targets clean; zero run-wide retries or failures; complete 10-artifact / 7,951-runner-event finalizer |
| 2 | `113365974235070` | `483ff540` | #2467 | both targets clean; complete 10-artifact / 7,625-runner-event finalizer; unrelated retry classified below |
| 3 | `497719938401885` | `65cf9dec` | #2467 | both targets clean; complete finalizer |
| 4 | `105920886681524` | `dc0ce4fe` | #2467 | both targets clean; complete finalizer |
| 5 | `114044928448857` | `dea98701` | #2470 | both targets clean; complete finalizer |
| 6 | `294834303475777` | `b9c2364b` | #2470 | both targets clean; complete 10-artifact finalizer |
| 7 | `160813051357004` | `24586385` | #2467 | both targets clean; complete 10-artifact finalizer |
| 8 | `454307980408418` | `70701a66` | #2470 | both targets clean; complete 10-artifact finalizer |
| 9 | `263677043387377` | `cd66a8ca` | #2469 | both targets clean; complete 8-artifact / 6,687-runner-event finalizer; unrelated retry classified below |
| 10 | `81253986898872` | `73063073` | #2467 | both targets clean; complete 10-artifact / 7,942-runner-event finalizer |
| 11 | `140816095847378` | `137b7425` | #2469 | both targets clean; complete 8-artifact / 6,585-runner-event finalizer; unrelated retry classified below |
| 12 | `368039917139070` | `bb351744` | #2473 | both targets clean; complete 8-artifact / 6,806-runner-event finalizer; unrelated retry classified below |
| 13 | `293927096273794` | `4808070a` | #2469 | both targets clean; zero run-wide retries or failures; complete 8-artifact / 6,487-runner-event finalizer |
| 14 | `204202074715153` | `7941dac4` | #2470 | both targets clean; corrected stream fence clean; complete 10-artifact / 8,003-runner-event finalizer |
| 15 | `476025826996334` | `921cfc4b` | #2467 | both targets clean; corrected stream fence clean; complete 10-artifact / 7,893-runner-event finalizer |
| 16 | `171901776700561` | `cc288de0` | #2473 | both targets clean; zero run-wide retries or failures; complete 8-artifact / 6,650-runner-event finalizer |
| 17 | `134965373738416` | `ff906eb0` | #2473 | both targets clean; zero run-wide retries or failures; complete 8-artifact / 6,795-runner-event finalizer |
| 18 | `510094541966125` | `0a177172` | #2473 | both targets clean; zero run-wide retries or failures; complete 8-artifact / 6,576-runner-event finalizer |

Manual workflow `350306797014989` on `081ff01f` proved default PostHog delivery and is intentionally excluded from the counter.

Clean retained workflows `325468040145880`, `113667258961351`, `414952340551888`, `125878215837805`, `16468339911133`, `163087930848889`, `196321000027745`, `103811399679244`, and `15300705470593` are intentionally excluded because they began before #2460 merged. Their original event timestamps remain before the cutoff even when retained telemetry is replayed.

Natural workflow `278234786942377` on `965beafd` is intentionally excluded: both restored targets were clean, but the complete finalizer correctly reported an unrelated Vitest failure and retry.

Natural workflows `223122126291692` on `2231c91d` and `440009111509530` on `f0af39c9` are intentionally excluded: both restored targets were clean, but their complete 10-artifact finalizers correctly reported the stream fence failure and retries elsewhere in the OS suite.

Natural workflow `274645031538687` on `b4cc9f19` is intentionally excluded. Its complete 10-artifact / 7,958-runner-event finalizer records the approval target clean and the notification target passed after one retry. The first notification attempt posted to `auth.iterate-preview-1.com/api/auth/email-otp/send-verification-otp` at `2026-08-10T15:43:26.981Z`; the Playwright trace captured HTTP 429 and CF-Ray `a2901dc1b807f6c0-IAD`, so the OTP screen never appeared. The run predates #2470's preview/test-only fixed-code OTP limit fix. Subsequent natural occurrences on and after #2470 passed the notification target first attempt.

Natural workflows `370920415886619`, `27609660171588`, `573090727616350`, `339482333644390`, `229363401043836`, `278066743824724`, and `417415455450839` are intentionally excluded. Each began after #2460 merged but before its tested head contained the Notifications-route repair. Both restored targets failed after retry while waiting for the absent Notifications drawer button. The first six exact retained artifacts cover every post-merge workflow before the accepted baseline; `417415455450839` began one minute before #2472 merged. #2472 identifies the integration regression—#2453 removed the Notifications view's only in-app entry point—and restores it as `/notifications`. Natural workflows `210117396829984` and `473171817387158` explicitly skipped both targets and are not occurrences. Later natural occurrences passed both targets first attempt.

Workflow `473171817387158` on #2376 head `3c771abc` had three unrelated Vitest retries. `workspace-edit-and-push` first hit Cloudflare's explicit Durable Object storage-reset reference `quflolvtqvdvd21cb9f18se4`, then passed. `Live bare function capabilities survive provideCapability return` first created project `prj_eb26bb0c601f47f891e98cd197b28cf3` on exact `os-preview-3` version `d714748a-2ee1-413f-9cfd-24a61fd5c55a`: at `2026-08-10T20:17:17Z`, both its root `project` processor and `/repos/config` `repo` processor failed their 20-second hosted-batch acknowledgement deadlines; `Project.create` then reached its 90-second `wait-project-birth` deadline and returned the reported offset-7 timeout. Trace `376a32ffccb2fdd7a753c1a11c7c1500` and ITX call `log_c661807ad49147b0b22b20087532dba0` retain the failed chain. The framework retry opened trace `aa43d8336208e662964e00a5a1172991`, created fresh project `prj_ffd845c045a941cb8f5d6a9f6c5fa7d3`, and reached `project/created` in 4.766 seconds. Finally, the known-gap `test.fails` case `a userspace facet rebuilds on a source commit and only on a source commit` unexpectedly passed once before its retry reproduced the documented stale-facet failure; unlike the other eleven expected-failure tests in the run, this case alone retried, so this is genuine nondeterministic product behavior rather than reporter inversion. These outcomes did not affect the skipped-target classification or finalizer completeness.

Workflow `274645031538687` also had one unrelated Vitest retry in `Agent scripts can send web-chat messages (with file attachments) and call project tools`. Exact-version `os-preview-1` telemetry ties its first attempt to project `prj_793f9b16f0e94bbc97c46f6c7e39493f` and WebSocket request `a2901c9c3b56822a`: `Stream.append` hit a retryable Durable Object reset at `15:42:53.384Z`; recovery re-appended successfully at `15:42:53.570Z`, but three re-armed one-shot `Stream.waitForEvent` calls reached their unchanged 30-second public deadline at `15:43:23.355Z`. The framework retry created a new project/session and passed. This did not affect the target-retry classification or finalizer completeness.

Workflow `204202074715153` had one unrelated Playwright retry in the seeded Docs app review. The first project reached the UI but showed `Event delivery retrying`: exact-version `os-preview-4` telemetry records 20-second hosted-processor acknowledgement timeouts for the root `project` processor and `/repos/config` `repo` processor. The bounded retry path later wrote both subscription cursors back to `attempt = 0` with `last_error` and in-flight state cleared; the Playwright retry passed. This was not a target retry and the finalizer was complete.

Workflow `476025826996334` had one unrelated Playwright retry in the two-dashboard-clients spec. Exact-version `os-preview-1` telemetry records a Cloudflare Durable Object storage reset during `appendCoreEvent` on Stream DO `ed08f734…` (trace `422ff29c…`, Cloudflare reference `cuf18o8ljkn8n2leevbe4j3c`). The single framework retry passed. This was not a target retry and the finalizer was complete.

Workflow `263677043387377` had one unrelated Playwright retry while checking that dismissing a new-file discard dialog preserves the edit. The failure snapshot shows the dialog was dismissed but the repo editor remounted `draft.md` without its buffered text and exposed no loading state, so Middlewright's one-millisecond no-spinner probe failed immediately. The framework retry passed. This was not a target retry and the finalizer was complete.

Workflow `140816095847378` had one unrelated Vitest retry in `invalid receiver-specific combinations and expressions never commit`. The first attempt failed with Cloudflare's explicit `stream-unavailable` Durable Object storage-reset reference `tuvl8nmdb9i7tgbd498oqo60`; the framework retry passed. This was not a target retry and the finalizer was complete.

Workflow `368039917139070` had one unrelated Vitest retry in the deliberate stream-restart egress test. Exact-version `os-preview-5` telemetry ties the first attempt to project `prj_41400cb01ad24c319b8f402585128806` and WebSocket request `a290f2553ef9d90d`: the intentional `Stream.kill` rejected at `18:08:56.803Z`, the decision append then succeeded and the script returned 200, but the settlement `Stream.waitForEvent` reached its fixed 30-second deadline. This is the pre-#2467 settlement gap that #2467 fixes; its later canonical proofs are clean. This was not a target retry and the finalizer was complete.

Workflow `113365974235070` had one unrelated Vitest retry in `a receiver accepts the same offsets again after its source is deleted and recreated`. Exact-version `os-preview-8` telemetry shows the first attempt spent its 45-second test timeout entirely in project bootstrap: config-repo terminal delivery made three bounded cross-Durable-Object calls while waiting for acknowledgement, including two 20-second JS-RPC calls, so `project/created` arrived after 45.45 seconds. The project then reached a coherent terminal state and its test body ran cleanly; the framework retry passed. This was not a target retry and the finalizer was complete.

The six early missing-route workflows also exposed unrelated in-progress-branch outcomes. Workflow `573090727616350` had one REPL example pass on retry after its existing 15-second event wait. Workflow `339482333644390` ran #2469 before `fc064c32d` fixed its scope-sensitive examples and SSR spec; its repo-editor retry matches the separately classified remount/readiness failure above. Workflow `229363401043836` was a broad preview-2 platform incident: retained telemetry records independent Cloudflare internal-error references and WebSocket failures across onboarding, resilience, dashboard, REPL, and worker tests, plus the in-progress #2469 failures. These workflows remain excluded regardless of their clean target setup because both restored targets hit the known missing-route defect.
