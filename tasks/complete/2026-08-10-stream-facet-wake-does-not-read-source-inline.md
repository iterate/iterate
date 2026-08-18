---
status: complete
size: medium
---

# Stream Facet wake does not read its source inline

## Status summary

Complete. The actor cycle is removed, focused regressions and package checks
pass, and a fully clean natural canonical preview run passed the former
45-second timeout first-attempt in 11.8 seconds. Its project-create trace shows
zero source subrequests beneath the hosted processor-facade wake; later reads
run in their independent catch-up/barrier scopes.

## Problem

PR #2467's docs-only canonical preview run retried
`a receiver accepts the same offsets again after its source is deleted and recreated`.
The first attempt spent 45.45 seconds in `Project.create`; the actual reset and
recreation assertions later completed successfully on the abandoned attempt.

Trace `1f8053f62509a7ef80af56c499444679` showed the source Stream alarm retaining
`wakeStreamProcessor`, while its colocated Processor Facet tried to read
`getEventPage` from that same source. The nested read waited about 37.8 seconds
for the source turn which owned the wake. This is an actor cycle, not a slow
test and not a source-recreation failure.

## Checklist

- [x] Add a red regression proving a trusted hosted wake does not read back
      into its source Stream. _The registry spec failed on the runner's inline
      identity read before the implementation changed._
- [x] Keep stale reduction-cache refolds out of the wake RPC too. _Hosted open
      now returns the durable effect cursor first and defers refold/load to the
      independent one-way batch callback; a runner spec covers a failed and
      retried deferred refold._
- [x] Run the complete runner/registry suites and package typechecks. _All 51
      focused tests pass; OS and `iterate` package typechecks pass._
- [x] Deploy preview 1 and run the exact formerly-retrying spec without a test
      retry layer. _Preview worker `55e991b7-3e83-4508-b0a7-b8842c5322b5`
      passed the filtered Vitest command directly, with no framework retry._
- [x] Run canonical preview CI without retries and audit the project-create
      trace for a bounded wake/read sequence. _Natural workflow
      `294834303475777` passed the target first-attempt in 11,761 ms and the
      whole run had zero failures or retries. Trace
      `ad0dd6cff34f4190a33d592f04f02ce2` contains zero source subrequests below
      all nine processor-facade RPC spans; independent same-facet reads were
      successful and bounded to 1,368 ms._

## Implementation log

- 2026-08-10: The failing attempt's `Project.create` call was
  `log_9fb77830554e40699eb03a11de87b3d1`. Its Stream alarm fired about 37.9
  seconds late only because the same source turn still owned the facet wake.
  The retry created its project in 7.49 seconds and the product behavior passed.
- 2026-08-10: Canonical preview run `t8l3czqmv5` proved the fixed target on its
  first attempt in 12.2 seconds. Two unrelated Playwright retries carried
  Cloudflare DO storage-reset references `kpc2frhccd9lun481bs84l74` and
  `6mohha84pjb2eum30ps0sviv`; one unrelated Vitest retry carried the explicit
  code-update reset. The remaining MITM timeout and delayed reactivity-live
  transition still require classification.
- 2026-08-10: The delayed reactivity-live transition was a Cloudflare storage
  reset (`p965faedfvqk7ccvdmle9d4q`) inside the `Stream.openConnection`
  subrequest in trace `97f531953fd9e47db01194f872fd51ea`. The sandbox WSS
  probe never reached `ProjectEgress.fetch`; both passed in the next canonical
  run, which had no storage/reset burst.
- 2026-08-10: The next run's only retry was a second immediate AI Gateway cache
  MISS. Cloudflare documents cache writes as volatile, so the test now models
  MISS as a bounded, logged warmup state instead of consuming a framework
  retry. The pre-fix canonical failure is the red proof.
- 2026-08-10: Natural canonical workflow `294834303475777`, Depot workflow
  `8ctt8cvf6k`, ran against preview-4 worker version
  `6f25540f-b948-47ba-8d24-cca9e96ff1c8`. The complete run had no test
  failures, retries, passed-after-retry tests, or incomplete finalizers.
- 2026-08-10: The target project was
  `prj_9cd52919d0634eb391a5be1a9b9565cf` (Ray `a290b7becaece61d`). Its
  `Project.create` span completed successfully in 6,540 ms. Across the exact
  trace's 92 JSRPC spans and 85 Durable Object subrequest spans, no subrequest
  had any processor-facade span as its parent. The nine later reads from the
  colocated source all completed successfully in 7–1,368 ms beneath explicit
  `catchUp`, `snapshot`, or `waitUntilProcessed` scopes.
- 2026-08-10: Two retained processor-facade capabilities ended with
  Cloudflare's `canceled` lifecycle outcome after their owning call stopped
  retaining them. Both are info-level `jsrpc OK` spans, neither owns a source
  subrequest, and the enclosing `Project.create` plus all read/processing spans
  completed successfully; they are capability disposal, not failed work.
  Trace: https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/ad0dd6cff34f4190a33d592f04f02ce2
