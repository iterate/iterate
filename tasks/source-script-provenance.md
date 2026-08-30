---
status: in-progress
size: large
branch: source-script-provenance
---

# source.script: host-stamped provenance on script appends

## Status summary

Fleshed-out spec (design agreed with Misha via explainer); implementation
starting. One PR: platform stamp + the first consumer (agent-ui fold
attribution, fixing the stale-status-between-rounds bug) + tests.

## Why

Every capability call a script makes already travels with a host-minted
`StreamContext { kind: "script-execution", executionId, streamPath,
scriptRunRequestedEventOffset }` — the egress door keeps it (approvals show
which script asked), but `StreamRpcTarget.append` drops it, so journal
events don't say which script wrote them. The UI then guesses attribution
by timing, which produced the stale-status bug (#2552, parked): a script
batches its `summary-updated` append with `sendMessage` + return, the
status event can journal after the settle that flushed the card, and the
fold had nothing to hang it on.

Design notes + call graphs: explainers.ignoreme/source-script-provenance.html
(also published as a Claude artifact for Misha's phone).

## Decisions (agreed)

- Envelope-level: `StreamEvent.source.script?: { executionId, streamPath,
  scriptRunRequestedEventOffset }` — sibling of `processor`/`copiedFrom`.
- HOST TRUTH, unlike the processor stamp's claim semantics: the trusted
  append target strips any caller-supplied `source.script` and stamps its
  own when (and only when) the appending itx handle's StreamContext is a
  script execution. Scripts cannot forge or launder provenance.
- One PR including the first consumer: the agent-ui fold attributes
  `summary-updated` by `executionId` — stamping the matching code step in
  the live activity, or correcting the retained just-settled activity when
  the event raced the settle (same-id item re-emit; correction applies
  ONLY when that activity actually contains the execution — no time
  window). Foreign `streamPath` updates the stream-level status text only.
- Old journal events lack the stamp: legacy behavior (stamp running steps)
  stays as the fallback; historical cards may keep cosmetically stale
  labels.

## Checklist

- [ ] Schema: `source.script` in packages/iterate processors/schemas.ts
- [ ] `StreamRpcTarget` carries `streamContext`; every mint site threads it
- [ ] Append + keyed append strip caller `source.script`, stamp host truth
- [ ] Regenerate itx-api generated files (codegen after format)
- [ ] DECISIONS.md entry (apps/os/src/itx): source.script is stamped,
      never accepted
- [ ] Fold: attribution by executionId (live + retained-settled correction,
      foreign-stream handling, legacy fallback)
- [ ] Host-level test: a script's append journals the stamp; a forged
      caller `source.script` is discarded
- [ ] Reducer tests: port the three ordering tests from the parked
      mobile-interwoven-status branch, now driven by the stamp
- [ ] E2E: port specs/mobile/interwoven-status.spec.ts (verbatim weave)
- [ ] Existing suites green (os components/projector, mobile feed,
      live-status + approvals specs)

## Implementation log

(append as you go)
