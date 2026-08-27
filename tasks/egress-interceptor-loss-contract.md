---
status: ready
size: small
---

# Egress interceptor: give loss a contract

`itx.egress.intercept(handler)` keeps its handler in a memory-only slot on
the Project Durable Object. A DO restart (deploys, eviction) drops it
SILENTLY: the installing session's socket stays open while every egress fetch
falls through to the real egress lanes. This is the same hole the AI
interceptor had before it became a live capability mount
(tasks/complete/…ai-intercept-as-capability.md, PR #2528), and it has existed
since egress interception shipped.

Decide and implement one of:

- [ ] Migrate `egress.intercept` onto the capability machinery too, like the
      AI interceptor — a live mount at a reserved root path, consulted from
      the egress path. Open question from the AI migration that matters more
      here: the handler contract is `Request → Response` (bytes, streams) —
      verify both cross the capability invoke leg intact.
- [ ] Or: a session-bound liveness signal for the slot. Closed PR #2527 built
      exactly this (a plain WebSocket whose lifetime is the DO incarnation's,
      closing the session 4901 on far-side loss) covering BOTH slots; its
      egress half can be revived from that branch
      (`ai-interceptor-mount-invariant`) nearly verbatim.

Either way, the client contract should end up the same as the AI
interceptor's: an open session socket means a live interceptor; loss arrives
as a close event, never silence.
