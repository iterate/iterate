# 09 — Streams inherit the pager/wake mechanism for free

Type: research
Status: open
Blocked by: —

Jonas: "How do we make it so that, without any extra work, streams automatically benefit from [the
1000-device wake mechanism]?"

## The claim: the pager is a CONTEXT-substrate property, not stream-specific

If a stream is a **capability** on a context (D1/D2), and the context substrate provides the **pager/wake**
mechanism (D7) for _any_ live mount, then a stream subscription that would otherwise pin a DO automatically
uses the same pager — no stream-specific code. This is literally what PR #2386 did by hand (wake-on-append);
generalizing it means #2386 becomes _an instance of the context pager_, not a bespoke stream feature.

## The one real difference to reconcile: push vs pull trigger

- **General live capability** wakes **on CALL** (someone invokes it) → resume by **forwarding the pending
  call** (spike `capability-wake`).
- **Stream subscriber** wakes **on APPEND** (news arrives) → resume by **replaying from the cursor**
  (#2386).

Both are "a dormant party holding a hibernatable pager, woken by an event, then resuming." So the substrate
primitive is: **`pager(wakePredicate, onWake)`** — the _predicate_ differs (a call targeting me vs an append
matching my filter), the _resume_ differs (forward-the-call vs replay-from-cursor), the _channel_ is the same
hibernatable socket + attachment.

## Deliverable

Define the shared pager primitive so that: (a) a general live capability, (b) a stream subscriber, and (c) a
paged-in DO "device" (Jonas: a DO can BE a device) all use it with only a predicate + resume plugged in.
Confirm #2386's guards (socketId same-key, resurrection loop, at-most-once + dedupe) live in the shared
primitive, not per-consumer.
