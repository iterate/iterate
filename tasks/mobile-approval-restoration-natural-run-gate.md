---
status: in-progress
size: medium
---

# Monitor the restored mobile approval flows for 25 natural previews

Status: 10/25 qualifying natural canonical preview occurrences are queryable. The restored approval and notification specs passed first attempt in all ten; 15 natural occurrences remain. Four intervening natural runs are excluded and classified below: three had unrelated failures, while one target notification spec retried after preview auth returned HTTP 429. The corrected stream quiet-window fence passed first attempt in two canonical previews. No excluded run left incomplete telemetry.

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
- [ ] Observe 15 more qualifying natural canonical preview occurrences.
- [ ] Investigate any target retry, failure, incomplete finalizer, or missing-transition diagnostic before allowing the streak to continue.
- [ ] Record the final 25-workflow evidence set and close the restoration goal.

## Gate rules

- Manual `workflow_dispatch` validation proves a candidate but does not increase the counter.
- Retained telemetry from a naturally triggered run may be replayed idempotently when the runner predated the default-delivery fix; the trigger remains natural.
- A target retry or failure does not count and must be classified. Do not hide it with a timeout increase, a skip, or another retry layer.
- An incomplete or absent finalizer is a telemetry defect, not a clean occurrence.

## Evidence log

| count | workflow | head | PR | evidence |
| ---: | --- | --- | ---: | --- |
| 1 | `497719938401885` | `65cf9dec` | #2467 | both targets clean; complete finalizer |
| 2 | `105920886681524` | `dc0ce4fe` | #2467 | both targets clean; complete finalizer |
| 3 | `114044928448857` | `dea98701` | #2470 | both targets clean; complete finalizer |
| 4 | `294834303475777` | `b9c2364b` | #2470 | both targets clean; complete 10-artifact finalizer |
| 5 | `454307980408418` | `70701a66` | #2470 | both targets clean; complete 10-artifact finalizer |
| 6 | `160813051357004` | `24586385` | #2467 | both targets clean; complete 10-artifact finalizer |
| 7 | `81253986898872` | `73063073` | #2467 | both targets clean; complete 10-artifact / 7,942-runner-event finalizer |
| 8 | `204202074715153` | `7941dac4` | #2470 | both targets clean; corrected stream fence clean; complete 10-artifact / 8,003-runner-event finalizer |
| 9 | `476025826996334` | `921cfc4b` | #2467 | both targets clean; corrected stream fence clean; complete 10-artifact / 7,893-runner-event finalizer |
| 10 | `171901776700561` | `cc288de0` | #2473 | both targets clean; zero run-wide retries or failures; complete 8-artifact / 6,650-runner-event finalizer |

Manual workflow `350306797014989` on `081ff01f` proved default PostHog delivery and is intentionally excluded from the counter.

Natural workflow `278234786942377` on `965beafd` is intentionally excluded: both restored targets were clean, but the complete finalizer correctly reported an unrelated Vitest failure and retry.

Natural workflows `223122126291692` on `2231c91d` and `440009111509530` on `f0af39c9` are intentionally excluded: both restored targets were clean, but their complete 10-artifact finalizers correctly reported the stream fence failure and retries elsewhere in the OS suite.

Natural workflow `274645031538687` on `b4cc9f19` is intentionally excluded. Its complete 10-artifact / 7,958-runner-event finalizer records the approval target clean and the notification target passed after one retry. The first notification attempt posted to `auth.iterate-preview-1.com/api/auth/email-otp/send-verification-otp` at `2026-08-10T15:43:26.981Z`; the Playwright trace captured HTTP 429 and CF-Ray `a2901dc1b807f6c0-IAD`, so the OTP screen never appeared. The run predates #2470's preview/test-only fixed-code OTP limit fix. Subsequent natural occurrences on and after #2470 passed the notification target first attempt.

The same workflow had one unrelated Vitest retry in `Agent scripts can send web-chat messages (with file attachments) and call project tools`. Exact-version `os-preview-1` telemetry ties its first attempt to project `prj_793f9b16f0e94bbc97c46f6c7e39493f` and WebSocket request `a2901c9c3b56822a`: `Stream.append` hit a retryable Durable Object reset at `15:42:53.384Z`; recovery re-appended successfully at `15:42:53.570Z`, but three re-armed one-shot `Stream.waitForEvent` calls reached their unchanged 30-second public deadline at `15:43:23.355Z`. The framework retry created a new project/session and passed. This did not affect the target-retry classification or finalizer completeness.

Workflow `204202074715153` had one unrelated Playwright retry in the seeded Docs app review. The first project reached the UI but showed `Event delivery retrying`: exact-version `os-preview-4` telemetry records 20-second hosted-processor acknowledgement timeouts for the root `project` processor and `/repos/config` `repo` processor. The bounded retry path later wrote both subscription cursors back to `attempt = 0` with `last_error` and in-flight state cleared; the Playwright retry passed. This was not a target retry and the finalizer was complete.

Workflow `476025826996334` had one unrelated Playwright retry in the two-dashboard-clients spec. Exact-version `os-preview-1` telemetry records a Cloudflare Durable Object storage reset during `appendCoreEvent` on Stream DO `ed08f734…` (trace `422ff29c…`, Cloudflare reference `cuf18o8ljkn8n2leevbe4j3c`). The single framework retry passed. This was not a target retry and the finalizer was complete.
