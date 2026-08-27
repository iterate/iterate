---
status: spike
size: medium
base: ai-interceptor-mount-invariant (PR #2527)
---

# Spike: `ai.intercept` as a live capability mount

## Status summary

Exploratory, stacked on #2527 so the comparison is an honest diff, not an
argument. Question under test: should the AI interceptor be a **registered
project object** (a live capability mounted on the root scope, riding the
existing Capability Provider Pager machinery) instead of #2527's memory slot
on the Project DO plus a bespoke liveness socket?

## Corrected trade-off framing (from the PR discussion)

What the mount design does and does not buy, stated precisely:

- NOT more resilient for tests. A test handler is a live function in the test
  process under either design; it dies with the client session either way,
  and DO churn tears the session down with 4901 either way (the relay's
  MAXIMUM TEARDOWN). The recovery contract — reconnect on close, install
  again — is identical.
- NOT obviously less code. It deletes the AI half of #2527's liveness lane
  (~half of ~90 lines) but adds a sugar/translation layer and rewires the
  consult path.
- DOES reuse the pager machinery instead of a new lane, journals
  provision/disconnect facts on the root stream, and makes the mount
  discoverable.
- DOES open the production growth path: a model provider implemented as a
  durable/worker-backed capability (no client session at all) drops in with
  zero further platform work.
- COSTS a heavier consult: every intercepted attempt pays the capability
  host's page-and-lend-a-leg dance instead of one Workers RPC hop.
- CHANGES the trust boundary: any capability provider can serve
  `intercepted/*` models (still never real-model names — the namespace rule
  is unchanged and stays the journal-honesty guarantee).

## Plan

- [ ] `AiRpcTarget.intercept(handler)` becomes sugar:
      `capabilityHosts.get("/").provideCapability({ type: "live", path:
      ["aiInterceptor"], capability: handler })`, returning the same
      release-handle shape. Last-writer-wins maps to provide-at-same-path
      semantics (verify what the reducer actually does with a second provide).
- [ ] Consult path: `consultAiInterceptor` invokes the root scope's
      `aiInterceptor` capability through the capability-host facade instead
      of reading the Project DO slot. Map "no capability"/"offline" to the
      canonical `noAiInterceptorError` so the public failure contract holds.
- [ ] Delete the AI half of the interceptor liveness lane (egress keeps it —
      egress interception stays byte-level and slot-based).
- [ ] Rework the e2e: the churn that matters becomes the ROOT STREAM DO
      (capability host + pager parent), so the revival test kills
      `streams.get("/")` and expects the existing pager-lost 4901.
- [ ] Report in the PR body: net LOC, consult latency delta (rough timing
      from the e2e), and the list of semantic changes a reviewer must accept.

Explicitly out of scope: egress interceptor migration, hiding the mount from
discovery (spike accepts a visible `aiInterceptor` mount and records it as an
open question), durable/worker-backed providers (the growth path this spike
is evaluating, not building).

## Implementation notes

(log added during implementation)
