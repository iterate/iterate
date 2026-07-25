---
status: in-progress
size: medium
---

# Script runs must survive parked egress holds

## Status summary

Spec + root-cause analysis done; reproduction test and fix in progress. The
failing seam is identified in code (the egress door's hold loop treats a
transient stream Durable Object restart as fatal). Missing: the committed
red test, then the fix commit.

## Problem

Reproduced twice on preview 7 (evidence in `tasks/grouped-approvals.md`,
"Script runs don't reliably survive parked egress holds"): a script run whose
egress fetches are parked awaiting human approval settles
`failed / stream-unavailable: Network connection lost` while the human is
still deciding. Once the caller is dead, the eventually-granted holds race
cancellation — some release and settle 200, the rest strand as
"submitted — awaiting the egress door…" zombies until the 10-minute expiry.

- Incident A (run `f708de82`): died 56s into the wait, the same second the 12
  grants landed; 9/12 settled, 3 stranded.
- Incident B (`agent-output:313`): died ~19s into the wait, 1s BEFORE the
  grants; 8/12 settled, 4 stranded. The immediate retry run completed 12/12 —
  a race, not a hard limit.

Egress approvals are meaningless if a parked fetch cannot survive MINUTES of
human latency.

## Root cause (found by code reading, confirmed by the error's shape)

The error text `stream-unavailable: Network connection lost` is minted in
exactly one place: `rethrowStreamUnavailable`
(`apps/os/src/domains/streams/stream-unavailable.ts`) tagging a workerd
DO-lifecycle rejection on a stream stub call. By explicit contract
(`STREAM_UNAVAILABLE_MESSAGE_PREFIX` docs) these rejections are RETRYABLE:
the stream Durable Object reboots on the next call.

`StreamRpcTarget.waitForEvent` (`apps/os/src/rpc-targets.ts`) deliberately
does NOT hide lifecycle failures behind its own slice-recovery loop — it
rethrows them tagged, leaving retry policy to callers.

But the egress door's hold loop —
`ProjectDurableObject#awaitApprovalResolution`
(`apps/os/src/domains/projects/project-durable-object.ts`) — only re-arms its
chunked wait on the slice-timeout message. Its own comment claims
"(and transient stream restarts) just re-arm from the same cursor", but the
code never checks for stream-unavailable / DO-lifecycle errors. So one
transient stream DO restart/connection loss during a minutes-long hold:

1. rejects the in-flight `waitForEvent` chunk, tagged `stream-unavailable:`,
2. propagates out of `#holdForHumanApproval`, failing the parked fetch,
3. rejects the script's `Promise.all`, settling the whole run `failed`,
4. leaves the granted-but-unreleased holds to race caller cancellation —
   the zombie approvals the approver UI shows until expiry.

Incident timing fits: a 12-grant burst (A) is exactly when the stream DO is
busiest/most likely to recycle connections; B was a mid-chunk connection loss.

## Reproduction (the deliverable test)

New e2e test alongside `apps/os/e2e/vitest/egress-approvals.e2e.test.ts`:

- [ ] park a fetch on a hold rule; observe `human-approval-requested`
- [ ] `stream.kill()` the project root stream — the public chaos operator
      that injects the same DO-lifecycle rejection class the incidents hit
      ("Abort the current Durable Object incarnation; the next request boots
      it again")
- [ ] grant the approval afterwards
- [ ] assert the parked fetch still resolves 200 with the upstream response
      and `human-approval-settled` lands
- [ ] confirm the test is RED before the fix (fetch fails with
      `stream-unavailable`), commit it, then fix in a follow-up commit

## Fix (follow-up commit)

- [ ] `#awaitApprovalResolution`: also re-arm from the same cursor on
      retryable availability errors (`isRetryableDurableObjectAvailabilityError`),
      with the existing `#sleep` backoff pattern (cf. `#judgeResolution`'s
      key-state catch-up loop) so a hard-down stream doesn't hot-loop; the
      hold deadline still bounds everything, expiry stays the safe direction

## Out of scope (named residual risks, follow-up tasks)

- The caller→egress-door leg: the script isolate's fetch into the project DO
  is itself a long-open connection; if workerd recycles THAT, no in-door
  retry can save the run. Not what the incidents showed (their error carries
  the stream tag), but for multi-minute holds it deserves its own design
  (resumable/idempotent release, or heartbeats).
- A terminal fact for holds whose caller vanished (zombie approvals sooner
  than the 10-min expiry) — mostly mooted when runs stop dying, but the
  cancellation race at release time still exists.
- `subscription "project-worker" skipped poison event … Unable to deserialize
  cloned data` seen in the same trials — separate preview stream-DO
  instability (see `tasks/project-creation-wedge-preview7.md`).

## Findings log

- 2026-07-25: traced the incident error string to `rethrowStreamUnavailable`;
  confirmed `#awaitApprovalResolution`'s catch matches only
  `"Timed out waiting for stream event"` while its comment promises restart
  tolerance. `StreamRpcTarget.waitForEvent` line comments confirm lifecycle
  rejections are intentionally the caller's retry responsibility.
- The expiry sweep's `getEvents` and the keyed appends (`expired`, `settled`)
  already get one availability retry via `retryLoggedIdempotentOperation`;
  the unkeyed `human-approval-requested` append happens before parking, so a
  failure there fails fast without stranding anything.
