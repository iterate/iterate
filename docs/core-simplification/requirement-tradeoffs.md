# Requirement tradeoffs and actual delivery scope

This document separates three things that earlier drafts mixed together:
what the current source candidate preserves, a deliberate requirement
relaxation that may later remove more machinery, and optional proposals that
are not implementation work. It uses the original audit's physical-line
measurements only as an indication of where complexity gathered. They are not
current deletion counts.

The proof of concept permits breaking durable row shapes. A removed shape must
be refused or recreated. It does not need a compatibility migration, a
compatibility package, or a migration inventory.

## Current candidate: explicit delivery, with durable outcomes retained

A subscription now declares its delivery mode instead of acquiring it from the
result of resolving its target. A rewrite or a changed target can no longer
turn an ordered row into fan-out or live delivery behind the caller's back.

The candidate moves durable progress toward the private `subscriptions` facet,
while the context retains the event log, authority checks, current-row fences,
and the ordinary target invocation. It intends to retain the present durable
outcomes:

- ordered cursor progress, retry, halt and resume;
- fan-out selection, concurrency, retry and terminal reporting;
- config birth delivery authority, batching and wakes;
- live `provide` and live `subscribe` through the existing pager;
- ephemeral delivery on its existing best-effort path;
- processor authoring, React hooks, and the vanilla Iterate Cap'n Web client.

This is an ownership simplification, not a requirement relaxation. It removes
target-brand inference and duplicate delivery plumbing only if the private
facet and context together prove the same outcomes. The source has not yet
proved that parity, so it does not support a deletion or LOC claim.

| Change                                           | Behavioural result                                                                           | Status                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Delivery mode is explicit in the configured row  | Target resolution cannot silently change ordered, fan-out, or live behaviour.                | Candidate direction; requires full Workers coverage.                                              |
| Durable progress is held by the private facet    | The context does not need a second generic durable delivery loop.                            | Candidate direction; retry, halt/resume, fan-out, birth delivery, and authority remain required.  |
| Durable bodies stay in the context               | A retry rereads the durable range; the context owns body lifetime through target settlement. | Implemented in the resumed candidate; focused checks pass, runtime and performance proof remains. |
| Old row shapes are refused or contexts recreated | No silent replay with changed delivery meaning.                                              | Deliberate breaking-state contract.                                                               |

## Largest future requirement relaxation: no platform-owned durable broker for arbitrary targets

The original broker in `stream/subscription-delivery.ts` was 1,962 physical
lines at the audit point. Its largest requirement is not “durable events exist”
or “processors run”: it is that core accepts an arbitrary configured target and
operates a durable cursor/retry/halt/fan-out service for that target forever.

Relaxing that requirement would let an ordinary processor or worker own its
own checkpoint, retry policy, dead-letter policy, and side-effect idempotency.
The event log, reads, append, live callbacks, and processor authoring remain.
What changes is the platform guarantee that any target placed in core state
gets the platform's durable service automatically.

This is the largest gross payoff because it can remove a cross-cutting state
machine, not because the 1,962 lines are already deleted. It is **not** the
current candidate: the private facet still preserves the durable service while
its equivalence is proved. Adopt the relaxation only after a real consumer
shows eviction/replay, unavailable target, wake, and keyed-effect behaviour,
and after config birth delivery has a replacement. Breaking state makes an
explicit refusal or fresh context sufficient; it does not make silently losing
work acceptable.

## Other proposals, not current implementation claims

| Proposal                                                      | Requirement relaxed                                                                                     | What stays possible                                                                    | Status                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Terminate proxied WebSocket upgrades at a user-owned endpoint | `itx.fetch` no longer transparently forwards a 101 through a lent provider or survives a context reset. | HTTP fetch, streamed bodies, direct Cap'n Web calls, and user-owned WebSockets.        | Optional proposal. No current source deletion or behaviour change is claimed.                                              |
| Replace rewrite templates with an ordinary adapter worker     | A configuration row no longer intercepts arbitrary prefixes or substitutes `@` / `...@`.                | Named workers, `cd`, direct calls, jails, and adapters written in ordinary TypeScript. | Breaking design direction. Inventory actual rules and preserve jail/cross-context behaviour before removing template code. |

The adapter proposal changes API expressiveness: a one-line dynamic forwarding
rule becomes code. That is acceptable only where an adapter is clearer than a
second configuration language. It does not justify a general capability
schema, a public target-kind union, or a new provider protocol.

## Evidence required before any deletion

A source PR may delete an old branch only when it names the replaced outcome
and its equal-or-higher-fidelity test. For durable delivery, that includes
ordered-to-fan-out reconfiguration during a call, retry after restart, terminal
reporting, configured row replacement, config birth delivery, pager redial,
and ordinary processor/facet authority. For the durable-body recommendation,
measure concurrent slow and small deliveries, fan-out overlap, busy outcomes,
body bytes, and retry reads. Preview, latency, soak, and Workers Logs evidence
remain required; production rollout is outside this audit.
