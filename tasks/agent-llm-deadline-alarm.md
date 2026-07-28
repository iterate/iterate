---
status: todo
size: medium
branch: none
---

# Agent LLM request deadlines need a timer, not just a comparison

`llm-request-requested` stamps `expiresAt = now + 10min`, but nothing ever
fires AT that time: all three enforcement points are passive (transport
setTimeout dies with the incarnation on eviction; `#reconcileLlmObligations`
compares `now >= expiresAt` but reconcile only runs at the end of an at-head
batch; the 30-min backstop is reconcile-only). Recovery latency is governed
entirely by when the next batch happens to flow. The keepalive revival alarm
is the only clock, and it (a) walks a backoff ladder to 30min/6h and (b) can
be lost outright in the fire→re-arm window, after which a quiet stream sits
dark until an arbitrary external dial.

**Proven live (2026-07-14):** a prd-wide scan of 245 agent streams found two
turns whose in-flight requests had sat past their deadline for FOUR DAYS
(`/agents/web/2026-07-10t08-45-05-307z` and `.../harry-marr-anthropic`,
abandoned web sessions nothing ever woke). Both manually cleared with the
failure-completion append. A user returning to such a session would find it
wedged.

## Fix sketch (from the machinery map, file:line refs verified 2026-07-14)

1. In the agent's `reconcile`, compute `min(expiresAt over open llmRequests,
requestedAt + backstop)` and arm a host alarm slice at it (+grace), the
   way the scheduler DO already does (`scheduler-durable-object.ts:75`).
   Clear when no obligation is open.
2. Persist the deadline desire in DO KV next to the keepalive record and
   re-issue on boot (mirror `stream-processor-host.ts:301-311`) —
   `alarmSlices` is in-memory today.
3. On fire, run `catchUpInternal` for the due processor: the existing at-head
   reconcile (`agent-processor-implementation.ts:499/:529`) then settles the
   expired request and re-queues the trigger. No new recovery entrypoint.
4. Optional hardening: clamp the keepalive revival re-arm to
   `min(backoffMs, nearest open-obligation deadline)` and cap the first
   post-version-change rungs at ≤60s (rollover turbulence is the expected
   early-failure cause, not a poisoned host).

Worst case after 1–3: eviction at T, deadline alarm at T+10min, reconcile
fails-and-reschedules, reply ~T+11min — the contract `expiresAt` already
promises. Delicate machinery (stream-processor host/keepalive): full node-
harness tests per docs/writing-stream-processors.md; do NOT rush.

Context: found while forensically analyzing the 2026-07-14 "pirate thread"
(PR #1969) — which itself turned out NOT to be an instance of this gap (the
apparent 35-minute silence was an epoch-arithmetic mistake in the analysis;
the thread answered in 82s). The July-10 orphans are the real instances.
