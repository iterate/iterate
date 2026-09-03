# Performance — larger learnings, bigger refactors, and capability-dropping options

Companion to `2026-09-03-autoresearch-log.md`. Everything here is OUTSIDE the loop's rules (a
capability drop, a >10 % LOC change, a platform fact worth remembering) — for Jonas to decide.

## Platform facts learned (edge vs workerd)

## Bigger refactors (allowed by capability, too big for the loop)

## Capability-dropping options (faster, but they take something away)

## F-subreq — the per-invocation subrequest cap bounds single-session append bursts (2026-09-03)

Measured on the deployed worker: 100 `itx.append` calls pipelined over ONE capnweb WebSocket abort
with `Too many API requests by single Worker invocation`. Mechanism: the stateless `/api` worker
holds the socket; each client call becomes one Workers-RPC subrequest to the DO, all attributed to
the single stateless invocation that is pumping that socket, so ~1,000 in-flight calls trip the cap
(`limits.subrequests`, default 1,000; Cloudflare docs workers/platform/limits). A batched append (one
call, N events) is ONE subrequest and does not — 100 events batched cost 34.8 ms and one subrequest.

Why it matters and options (all capability-neutral, none small):

- It is the same class as apps/os's 10,000-delivery silent wall (review measure-next #1) but at the
  APPEND door, and it is LOUD (an error), not silent.
- Raising `limits.subrequests` to the 10,000 max buys 10× headroom for one config line, no code —
  worth doing regardless; a client can still exceed it.
- The durable answer is client-side: the SDK/client could coalesce a burst of single appends on one
  session into one multi-event append (the wire already supports N events per append). That is a
  client change, out of this loop's scope, and belongs with the connection-ergonomics work.
- The bench now guards this scenario (fewer in-flight, or a note) so a run completes.
