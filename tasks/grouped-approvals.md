---
status: ready
size: medium
---

# Group egress approvals by script run (Approval Groups)

## Status summary

Spec complete (grill-you interview: `tasks/grouped-approvals.interview.md`). Implementation not started. Design: debounced one-push-per-run in NotificationProcessor, grouped mobile approvals UI with one-Face-ID approve-all, per-request grant events unchanged.

## Problem

Enabling a `hold` egress rule (e.g. gmail) floods the approver: a script run doing `Promise.all` over ~50 requests produces ~50 approval requests, ~50 pushes, ~50 taps + Face ID prompts. Every held request already carries `streamContext.executionId` identifying its script run (`project-durable-object.ts:424`); nothing groups on it.

## Design (decided — see interview for reasoning)

**Approval Group** (term now in `apps/os/CONTEXT.md`): the set of held requests sharing one Script Execution's `executionId`. Not a persisted entity — a grouping computed over `human-approval-requested` events. Per-request grant/reject events remain the unit of record; a group is never signed or decided as a single unit (ADR `apps/os/docs/adr/0006-...md`).

- **Notifications**: NotificationProcessor gains a small explicit per-`executionId` state machine (documented exception to its stateless-per-event rule): debounce window opens on first hold (3s, extended per hold, 10s cap — tunable constants), alarm-from-reduced-state like SchedulerProcessor. At fire time: one `notification/requested` summarizing the FULL currently-open set ("Script run waiting: 12 requests (12x gmail.googleapis.com)" — host-only privacy), deep-linking via new additive `destination.kind: "approvals-group"` `{executionId}`. Zero pending at fire time → no push, still prune. Holds landing after a fired window start a new window/push (idempotency key includes first held offset of the window). Non-script scopes: today's immediate per-request behavior, untouched.
- **Mobile UI** (`apps/mobile/.../approvals.tsx`): bucket open requests by executionId. Singletons render exactly as today. 2+ pending → collapsed header (pending count, host breakdown, rule descriptions, view-script affordance via existing `scriptCodeForApproval`) with Approve all / Reject all on the header; expand for per-request cards (approve 11, reject 1). Group sorts by oldest pending member. In-flight batch shows partial progress ("granting 3/12…"), buttons disabled.
- **Signing**: new `signManyWithApproverKey(projectId, messages[])` — ONE authenticated SecureStore retrieval (one Face ID), N in-memory signatures, N ordinary grant events. Best-effort appends: no rollback possible on a stream; failures leave the remainder visibly pending with retry.
- **State bounding**: prune an executionId entry when all members resolved/expired and its window fired.

## Checklist

- [ ] NotificationProcessor: consume `human-approval-granted/rejected/settled`; per-executionId reduced state `{windowOpensAt, heldOffsets[], notifiedThroughOffset}`; alarm scheduling; window-close handler as a plain unit-testable function (no real sleeps — hard requirement)
- [ ] Group push intent: summary body (counts by host), `approvals-group` destination kind (additive union member), idempotency key `notification/approval-group@<executionId>:<firstWindowOffset>`
- [ ] Suppress-if-empty at fire time + state pruning
- [ ] Mobile: bucket by executionId in `deriveOpenRequests` (or alongside), grouped header UI, expand/collapse, per-request escape hatch
- [ ] Mobile: `signManyWithApproverKey` in `approver.ts` / `approver-core.ts`; best-effort append loop with progress + retry-pending UI
- [ ] Mobile: route `approvals-group` deep link → expand + highlight group; keep `approvals` kind working
- [ ] Unit tests: window open/extend/cap, late-arrival new window, suppress-if-empty, pruning, full-open-set counting across windows
- [ ] e2e: at most one real-time smoke of a grouped burst (extend `egress-approvals.e2e.test.ts` pattern)
- [ ] Demo recipe: hold rule on disposable echo host + itx script doing `Promise.all` of ~12 POSTs; PR body gets phone-trial instructions (metro + OS dev server over tailscale; captun fallback)
- [ ] Verify (not change) CLI `iterate approve` and menubar behave sanely on a grouped burst

## Out of scope

- Menubar app's own local-banner flood (`packages/iterate/menubar/Iterate.swift:320-344`) — named follow-up
- Non-HTTP approval holds (`tasks/approvals-beyond-http-egress.md`); capability-call-stack provenance (`tasks/capability-invocation-context.md`) — design composes, nothing more
- Web dashboard approvals UI; Android; batch signature schemes; egress rule schema changes

## Guesses and assumptions

- 3s/10s debounce numbers are taste — tunable constants `[guess]`
- One SecureStore retrieval → one Face ID prompt covers N signatures (confirm on device) `[guess]`
- Script source is the approver's real trust signal, so surface it from the group header `[guess]`
- Pruning on all-resolved-or-expired suffices; no separate GC sweep `[guess]`
- CLI/menubar need verification only, zero code changes `[guess]`

## For the next pass (follow-ups)

- Menubar local-notification debounce (Swift-side)
- "Trust the rest of this run for this rule" — run-scoped standing grant covering future unseen requests (bigger trust-semantics change, deliberately excluded from v1)
- `tasks/extract-approvals-protocol-to-package.md` would deduplicate approve-core ↔ mobile approvals lib, where the grouping derivation could live once
