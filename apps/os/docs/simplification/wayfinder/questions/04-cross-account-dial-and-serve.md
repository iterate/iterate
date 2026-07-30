# Q04 — Cross-account dial direction + the HTTP-serve lane

**Round 1. Status: open.**

## Two coupled sub-questions

### (a) Dial direction

When runner and control plane are in different accounts, who opens the socket?

- **(A) Runner _always_ dials out, uniformly (codex).** Same topology for cross-account AND
  home-assistant/NAT — no cross-account service binding ever attempted. The control plane holds the
  accepted session in a DO (Link Broker) with lease-epoch fencing. Uniform, NAT-native.
- **(B) Control plane dials the runner's `/api` (opus).** Simpler when the runner is publicly
  reachable; but needs a _second_ topology (dial-out) for NAT anyway.

### (b) The serve/streaming lane

All 8 proposals agree HTTP serving **cannot** ride RPC method-replay (WS 101 upgrades, streaming
bodies, backpressure, cancellation break it — it's what #2156 removed). Do we commit now to a
**dedicated fetch-native streaming adapter** (codex's `FetchTarget`: pull-based, conformance-tested),
rather than pretending `project.fetch(request)` over capnweb "just works" (opus's gap)?

## Recommendation

- **(a) → (A) always dial out.** One topology for cross-account and NAT; matches home-assistant (0013).
  Accept the known cost: **outbound WebSockets can't hibernate** (~15-min DO keep-alive) — the lab must
  measure it, and it may push us toward account-per-project (Q06) for hosted-at-scale.
- **(b) → yes, a dedicated streaming fetch lane.** Don't let the "same interface, different socket"
  elegance quietly break at the serving hot path. Design the adapter as a first-class rung requirement.

## Adjacent fork (fog, not this ticket)

Routing truth: KV-as-table (opus/plan) vs a Registry DO with KV as projection (codex), because KV is
eventually consistent ≥60s incl. negative lookups. Lean KV-as-projection; ticket separately.
