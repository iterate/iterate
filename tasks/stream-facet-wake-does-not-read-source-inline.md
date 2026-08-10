---
status: in-progress
size: medium
---

# Stream Facet wake does not read its source inline

## Status summary

Implementation and local regression proofs are complete. The actor cycle is
removed in the runner; preview deployment, the exact failed spec, canonical
CI, and trace review remain.

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
- [ ] Deploy preview 1 and run the exact formerly-retrying spec without a test
      retry layer.
- [ ] Run canonical preview CI without retries and audit the project-create
      trace for a bounded wake/read sequence.

## Implementation log

- 2026-08-10: The failing attempt's `Project.create` call was
  `log_9fb77830554e40699eb03a11de87b3d1`. Its Stream alarm fired about 37.9
  seconds late only because the same source turn still owned the facet wake.
  The retry created its project in 7.49 seconds and the product behavior passed.
