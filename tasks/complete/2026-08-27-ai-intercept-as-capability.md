---
status: implemented
size: medium
base: main (deliberately a competitor to PR #2527, not stacked on it)
---

# Spike: `ai.intercept` as a live capability mount

## Status summary

Promoted from spike to the real implementation (PR #2528, replacing closed
PR #2527) — Misha picked this design. All spike gaps below are settled; the
client half of #2527 (resilient spec helper, fixture.interceptAi, the
intercepted-models guide) is ported and adapted. Everything passes. Verdict: the mount design wins on the
evidence — roughly a quarter of #2527's server-side diff, zero new transport
machinery, the same recovery contract (proven by the same-shape 4901 e2e),
strictly better last-writer-wins semantics (offset-keyed handles: a
superseded release provably cannot evict the winner), 6ms warm consult
latency, and journaled provisions for free. Remaining gaps before it could
replace #2527 are listed under Verdict below.

Question under test: should the AI interceptor be a **registered project
object** (a live capability mounted on the root scope, riding the existing
Capability Provider Pager machinery) instead of #2527's memory slot on the
Project DO plus a bespoke liveness socket?

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

- [x] `AiRpcTarget.intercept(handler)` becomes sugar:
      `capabilityHosts.get("/").provideCapability({ type: "live", path:
      ["aiInterceptor"], capability: handler })`, returning the same
      release-handle shape. Last-writer-wins maps to provide-at-same-path
      semantics (verify what the reducer actually does with a second provide).
      _Done — a bare function mounts cleanly (replayPath calls it on an empty
      rest path); provide-at-same-path shadows, and the offset-keyed provision
      handle makes the loser's release a provable no-op (e2e-verified)._
- [x] Consult path: `consultAiInterceptor` invokes the root scope's
      `aiInterceptor` capability through the capability-host facade instead
      of reading the Project DO slot. Map "no capability"/"offline" to the
      canonical `noAiInterceptorError` so the public failure contract holds.
      _Done — the Project DO dials the root stream's capability-host facade
      (same narrow-stub seam as its reduced-state facade). Error mapping is
      string-matched ("no capability" / "is offline"), flagged below as the
      first thing a real version fixes._
- [x] Delete the AI half of the interceptor liveness lane (egress keeps it —
      egress interception stays byte-level and slot-based). _Moot off main:
      the lane never lands here at all — no liveness code exists on this
      branch. `interceptAi` and the `#aiInterceptor` slot are deleted from
      the Project DO._
- [x] Rework the e2e: the churn that matters becomes the ROOT STREAM DO
      (capability host + pager parent), so the revival test kills
      `streams.get("/")` and expects the existing pager-lost 4901. _All three
      e2e tests green, plus specs/agent-fake-model-chat.spec.ts (the
      agent-turn path) against a real dev server._
- [x] Report in the PR body: net LOC, consult latency delta (rough timing
      from the e2e), and the list of semantic changes a reviewer must accept.
      _See Verdict._

Explicitly out of scope: egress interceptor migration, hiding the mount from
discovery (spike accepts a visible `aiInterceptor` mount and records it as an
open question), durable/worker-backed providers (the growth path this spike
is evaluating, not building).

## Verdict

The evidence favors the mount design:

- **Diff size**: product-code diff vs main is ~+120/-50 across three files
  (sugar + consult rewrite + one constant); #2527's server side is ~+300
  across four files including a new 92-line transport lane. No new machinery
  at all here — the pager, 4901 carrier, journaled provisions, and
  offset-keyed revocation are all shipped code exercised by every live
  capability in the product.
- **Same recovery contract**: root-stream kill → existing pager-lost 4901 →
  reconnect + re-install → serving again, e2e-proven in the same shape as
  #2527's test. A live test handler is equally session-bound under both
  designs, as predicted.
- **Better LWW**: #2527 needed a custom "superseded" close reason so the
  loser stays silent; here the provision handle is offset-keyed, so the
  loser's release structurally cannot evict the winner (e2e-verified).
- **Latency**: 6ms warm consult round-trip through the page-and-lend-a-leg
  dance (local dev) — noise against LLM-turn timescales.

Spike gaps, now settled:

1. **Typed error mapping** — _done: the unserved-capability contract
   (factories + RPC-safe predicate) lives in one module,
   capability-host/capability-unserved.ts; every throw site and the consult
   predicate use it._
2. **Discoverability** — _accepted and documented
   (docs/intercepted-models.md): the mount shows in `__describe` like any
   capability; that is honest, not hidden._
3. **Trust boundary** — _accepted and documented: any capability provider can
   mount `aiInterceptor` — that IS the durable-provider growth path; the
   real-model namespace rule is unchanged._
4. **The egress interceptor** — _split out:
   tasks/egress-interceptor-loss-contract.md (migrate to a mount, or revive
   the closed #2527's liveness lane for egress only)._
5. **Port #2527's client half** — _done: helper, fixture members, spec
   migration, and the guide, with the guide's lifetime section rewritten for
   the mount machinery._

## Implementation notes

- Root capability host is born by project creation
  (project-processor-implementation.ts appends capabilityHostCreationEvents
  for "/"), so the sugar needs no create() dance.
- `ProjectAiInterceptRpcTarget` became rpc-targets-internal (the Project DO
  no longer constructs it); knip caught the stale export.
- The spike keeps `consultAiInterceptor` on the Project DO purely to avoid
  rewiring the two callers (processor facet dep + AiRpcTarget.run); a real
  version could route both straight to the capability host and cut the
  Project DO out of the AI path entirely.
