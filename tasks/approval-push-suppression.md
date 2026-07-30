---
status: ready
size: medium
---

# Suppress approval pushes the user is already looking at

## Status summary

Spec committed, implementation not started. Split out of #2339's task
(`tasks/complete/2026-07-30-in-thread-approvals.md` › "Push suppression"),
which shipped the in-thread dialog this builds on.

## Ask (Misha, via #2339 follow-ups)

Only send the approval push notification if the user isn't already in the
app: give the mobile client ~a second to say "don't worry, I've shown it" —
the in-thread dialog sends that claim when it renders. A claim inside the
window cancels delivery for that batch; a claim after the push went out is a
harmless no-op.

## Design

Constraints settled during #2339 (see its implementation log):

- The notification processor stays stateless-per-event (ADR 0007). The grace
  window lives in the DEVICE processor, whose obligations are already
  state-derived with an alarm (`receiptCheckDelayMs` sets the precedent).
- The seen-claim must reference the approval BATCH offset — the client sees
  root-stream approval events, never device-stream offsets. So the
  `notification/requested` intent must carry `approvalRequestEventOffset`
  even for `agent-chat` destinations (today only the `approvals` destination
  carries it).
- Grace expiry needs the device DO's alarm to nudge the state-derived send
  pass — with no new events, nothing else wakes it.

Decisions made while fleshing out (assumptions, flag in PR if wrong):

- **Intent change**: hoist `approvalRequestEventOffset` to a top-level
  optional field on the `notification/requested` payload (set for approval
  batches regardless of destination kind). The destination union keeps its
  current shapes.
- **Claim event**: `project/approval-presented`
  `{ approvalRequestEventOffset }`, appended to the project ROOT stream by
  the mobile chat screen when an in-thread batch card renders while the app
  is foregrounded (one claim per batch per screen mount is enough; duplicate
  claims are no-ops). Root stream, not the device stream: the user saw it, so
  EVERY device's pending push for that batch should die, and the root stream
  is what all devices already subscribe-copy from.
- **Copy rule**: extend the existing device subscription (the one that copies
  `notification/requested` onto each device stream) to also copy
  `project/approval-presented`.
- **Device processor**: obligations whose intent carries
  `approvalRequestEventOffset` are not runnable until
  `requestedAt + config.approvalGraceMs` (default ~1500ms). The at-head pass
  arms the DO alarm at the earliest pending grace expiry (same slice pattern
  as receipt checks). A reduced claim marks matching open obligations; the
  send pass settles them with a new terminal outcome `suppressed` instead of
  attempting. Claims for unknown/settled obligations reduce to nothing.
- **Expiry interplay**: a batch's own `expiresAt` keeps working unchanged;
  grace only delays the attempt, never extends anything.

## Checklist

- [ ] `notification/requested` intent carries `approvalRequestEventOffset`
      for approval batches on both destination kinds (+ notification
      processor test)
- [ ] `project/approval-presented` event type on the project root stream,
      appended by the mobile chat screen when the in-thread dialog renders
      foregrounded
- [ ] Device subscription copies the claim event onto device streams
- [ ] Device processor: `approvalGraceMs` config, grace-delayed attempts,
      alarm nudge at earliest grace expiry, `suppressed` terminal outcome
- [ ] Device processor tests: push goes out after grace with no claim; claim
      inside grace suppresses (no attempt started); claim after send is a
      no-op; alarm re-arms correctly; non-approval intents are unaffected
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Web dashboard claims (mobile first; the event shape is client-agnostic)
- Per-device (rather than per-user) suppression semantics
- Any change to expiry or decision semantics
