---
state: backlog
priority: medium
size: large
tags: [os, approvals, egress, security, capability-host, streams, jam]
---

# Signed human approval as a general capability — not just HTTP egress

## The idea (jam)

The egress-approvals feature (PR #1868) proved a specific, legible instance:
an outbound HTTP request that matches a `hold` rule is parked until a human
signs an approval the platform can verify but not forge. But the primitive
underneath — **"this consequential operation needs a fresh, signed human
yes"** — is not HTTP-specific. It should be able to gate _any_ consequential
thing a project does: a userspace worker deleting data, moving money through a
vendor SDK, a destructive itx call, an agent tool call, a deploy — and even
**changes to the approval policy itself**.

Jonas's framing that sparked this:

> "to add a rule, a valid signature is required. so it's a good example of
> follow-on work … that shows that not just http requests require approval."
>
> "would be cool if even userspace worker code etc could require approval for
> stuff — not just http egress requests. ideally there could be an API that
> wraps a promise or something."

Two shapes fall out of that, and both are worth building.

## Shape A — an opt-in promise-wrapping API (userspace asks)

The dream ergonomics: userspace code (a worker, an itx script, an agent tool)
wraps a consequential step and it just _blocks on a human_:

```ts
// inside a project worker / itx script
const result = await itx.approvals.require(
  {
    action: "refund",
    summary: `Refund £${amount} to order ${orderId}`, // human-readable, rendered in the approver UI
    params: { orderId, amount }, // hashed into what gets signed
  },
  async () => doTheRefund(orderId, amount), // runs only after a signed approval
);
```

Mechanically this is the SAME hold-and-release the egress gate already does,
lifted off HTTP:

1. `require(...)` appends a `human-approval-requested`-shaped event (generalized
   payload: `{ action, summary, paramsHash, secretPaths?, ... }`) to the
   project stream and parks the caller's promise keyed by the event offset.
2. The approver surfaces (terminal / `--native` / menu-bar `Iterate.app`) already
   render held requests and append signed grants — they'd render an arbitrary
   `action` + `summary` instead of `method`/`host`.
3. On a verified `granted`, the wrapped thunk runs; on reject/expiry it throws.
   `settled` records the outcome, same as egress.

Research/spec questions:

- **Where does `itx.approvals.require` live and how does the hold survive the
  worker execution model?** The egress hold works because it's inside the
  Project DO's `fetch`. A userspace `require()` call is an itx RPC into the DO —
  the DO can hold the promise the same way (chunked `waitForEvent` on `/`), but
  the caller (dynamic worker / script) must tolerate a long-open RPC. Verify the
  capnweb/worker timeout story for multi-minute holds (the egress path already
  chunks ≤25s; reuse it).
- **What gets signed?** Generalize `approval.v1`: `{ v, projectId, offset,
action, summary, paramsHash, decision }` instead of the HTTP-specific fields.
  The human signs a description of the _action_, not raw bytes. The
  summary-trust question resurfaces (see below).
- **Idempotency / exactly-once**: unlike egress (where a lost hold just fails the
  fetch), a userspace `require()` wrapping a side effect wants exactly-once
  semantics on approval → this is where the deferred _reconciler-owned release_
  from #1868 becomes load-bearing.

## Shape B — policy-gated capability calls (platform intercepts)

The egress case is _policy-gated_: rules on project state decide what's held,
the code doesn't ask. Generalize that to itx capability dispatch: a policy like
"any `itx.files.delete` / `itx.sandboxes.destroy` / `integrations.stripe.*`
mutation is held" evaluated at the capability-host invoke seam
(`capability-host` `invokeCapability` / the dynamic dotted-path calls), the same
way `matchEgressRule` runs at the egress door. This needs:

- a rule vocabulary over capability paths (mirror `EgressRule.match`, but over
  `path`/method/args instead of host/URL);
- the hold to happen at the invoke boundary in the capability host DO;
- rendering a capability call as a human-readable summary.

This is the more powerful, more invasive one — it makes approval a property of
the _platform_, not something userspace has to remember to call.

## The flagship demo — the policy protects itself

The cleanest proof that "not just HTTP": make the policy-mutation events
themselves require a signature —
`events.iterate.com/project/egress-rules-configured`,
`human-approval-key-added`, `human-approval-key-revoked`. Then you cannot:

- weaken/remove a `hold` rule,
- enroll a rogue approver key,
- revoke a legitimate key,

…without a signed human approval. **The guardrails guard themselves.**

The seam here is different from the egress door — it's **event append/reduce
time**, not egress time. Options to research:

- Pre-commit validation in the Stream DO (`validateAppend` in
  `stream-durable-object.ts`) — reject an unsigned mutation before it becomes a
  durable fact (there's precedent: `parseEventInput` pre-commit rejection).
- Or reduce-time: accept the event but only fold it if signed (weaker — the
  event is durable but ignored).
  Bootstrap falls out the same as grants: **unsigned appends allowed until the
  first key is enrolled, signature-required after** — so the first rule/key can be
  set, then the policy locks to signed mutations. `evaluateGrant`
  (egress-approvals.ts) is already exactly this policy function; generalize it to
  "evaluate a signed event" and reuse it at the new seam.

## Cross-cutting research

- **Generalize the canonical message + `evaluateGrant`** out of the HTTP
  framing so all three seams (egress door, capability invoke, event pre-commit)
  share one signature scheme. Today `buildApprovalMessage` is HTTP-shaped;
  factor an `action`-shaped core.
- **Summary trust**: what the human reads must be what the signature covers.
  Rule/policy-authored summaries are trustworthy; an LLM-narrated summary is
  readable but must be rendered as untrusted annotation, never as the signed
  meaning. (Same open question flagged in #1868.)
- **One approver UI for everything**: `iterate approve` + `Iterate.app` already
  tail `human-approval-requested` and sign grants. If the generalized events
  reuse that type (or a superset), the existing surfaces work unchanged for
  code/policy/capability approvals — big leverage, worth designing for.
- **Keys → apps/auth**: the deferred move of the public-key registry into
  `apps/auth` D1 matters more here (a general approval capability is exactly the
  "real security" surface auth is meant to own).

## Prior art / related in-repo

- PR #1868 — the egress instance this generalizes (the working reference for
  hold-and-release, `evaluateGrant`, the signature scheme, the approver
  surfaces).
- PR #346 "basic human in the loop" (mmkal, Oct 2025, since removed) — tool-call
  approval via Slack reactions + injected tool calls. Its "stuff I don't like"
  list (approval key brittleness, replay-by-injection, mushy approver auth) is
  precisely what signed + event-sourced approvals fix. Shape A is the modern
  redo.
- Permission slips (deferred in #1868) — pre-signed capability tokens; the flat
  matcher vocabulary was kept open for this.
- The capability host (`invokeCapability`, dynamic dotted-path calls) — the
  natural seam for Shape B.

## Suggested first slice

Do the **self-protecting policy** first (flagship, smallest, highest signal):
require a signature on `egress-rules-configured` + key add/revoke, verified at
Stream-DO pre-commit, with the unsigned-until-first-key bootstrap. It reuses
`evaluateGrant` almost verbatim, needs no new UI, and demonstrates "not just
HTTP" with the tightest possible diff. Shape A (the `itx.approvals.require`
promise wrapper) is the marquee follow-up once the generalized signature core
and reconciler-owned release exist.
