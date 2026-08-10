---
status: in-progress
size: medium
---

# Stream Facet wake does not read its source inline

## Status summary

Implementation, local regressions, preview deployment, and the exact canonical
spec proof are complete. The actor cycle is removed: the former 45-second
timeout passed first-attempt in 12.2 seconds. Five other canonical retries are
being classified before this follow-up can be called release-clean.

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
- [ ] Run canonical preview CI without retries and audit the project-create
      trace for a bounded wake/read sequence. _Canonical run `t8l3czqmv5`
      passed the target first-attempt in 12,193 ms (`retryCount: 0`), down from
      the prior 62,980 ms aggregate retry. Five unrelated cases retried, so the
      run is not accepted as release-clean._

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
