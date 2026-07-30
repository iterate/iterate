---
status: ready
size: medium
---

# Suppress approval pushes the user is already looking at

## Status summary

Implemented end to end: intent carries the batch identity top-level, the
claim event exists on the root stream, devices grace-delay approval pushes
and settle them `suppressed` on a claim, the DO grace alarm nudges the send
when no claim comes, and the mobile in-thread card appends the claim. All
targeted tests green; awaiting full-suite/CI confirmation and review.
Remaining: nothing known — see the implementation log for accepted edge
cases.

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

- [x] `notification/requested` intent carries `approvalRequestEventOffset`
      for approval batches on both destination kinds (+ notification
      processor test)
      _optional top-level field in notification-intent-contract.ts (0.2.0);
      set from `event.offset` in notification-processor-implementation.ts;
      both existing destination-kind tests now assert it_
- [x] `project/approval-presented` event type on the project root stream,
      appended by the mobile chat screen when the in-thread dialog renders
      foregrounded
      _defined in the standalone `approval-presented-contract.ts` catalog
      (spread into the project contract's events — the device contract must
      consume it too and cannot import the project contract back); appended
      by `InThreadApprovalCard` via a staleTime-Infinity useQuery gated on
      `AppState.currentState === "active"`, idempotency-keyed per batch_
- [x] Device subscription copies the claim event onto device streams
      _`notificationIntentSubscriptionEvent`'s filter now lists both types;
      existing devices pick it up on their next enrolls/token-update re-arm_
- [x] Device processor: `approvalGraceMs` config, grace-delayed attempts,
      alarm nudge at earliest grace expiry, `suppressed` terminal outcome
      _contract 0.5.0: `approvalGraceMs` (default 1500ms), obligations gain
      requestedAt/presentedAt/approvalRequestEventOffset, `suppressed`
      outcome; implementation: claim reduce, suppressed sweep, grace-gated
      send loop, `releaseApprovalGraces` called by the DO's new
      `device-approval-grace` alarm slice_
- [x] Device processor tests: push goes out after grace with no claim; claim
      inside grace suppresses (no attempt started); claim after send is a
      no-op; alarm re-arms correctly; non-approval intents are unaffected
      _"DeviceProcessor approval-push suppression" section in
      device-processor.test.ts — four specs matching exactly these cases_
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Web dashboard claims (mobile first; the event shape is client-agnostic)
- Per-device (rather than per-user) suppression semantics
- Any change to expiry or decision semantics

## Implementation log

- **Contract ownership vs import cycle**: the project contract imports the
  device contract (processorDeps), so the device contract could not import
  the claim's schema from it. `defineProcessorContract` accepts standalone
  event catalogs as `processorDeps`, so the claim lives in
  `apps/os/src/domains/projects/approval-presented-contract.ts`, spread into
  the project contract's `events` (docs-site ownership) and listed as a dep
  catalog by the device contract (typed consumption). One schema, no drift.
- **Why an explicit `releaseApprovalGraces` method instead of "the alarm
  nudges catchUp"**: the runner's catchUp early-returns when there are no
  new events (stream-processor-runner.ts, the
  `pending.length === 0 && scanned === committed` guard), so it never fires
  the eventless at-head pass on a pure clock tick. Grace expiry appends
  nothing, hence the checkReceipts-shaped method the DO alarm calls with the
  current state; it re-arms/disarms its own slice.
- **Accepted race (per spec)**: a claim copied onto the device stream BEFORE
  its intent copy reduces to nothing, and the later intent still sends after
  grace. Requires the mobile claim to beat the notification processor's
  intent append on the root stream — unlikely, and the failure mode is just
  the pre-feature behavior (push arrives while looking at the app).
- **Replay caveat carried over from #2339**: intents already committed
  without the top-level field would re-append with a DIFFERENT body if the
  notification processor ever re-processed those events with lost progress
  (idempotency same-key conflict → wedge). Same exposure #2339 accepted when
  it changed the destination shape; progress loss without cache loss is a
  crash-window rarity. Old committed intents (no top-level field) reduce to
  UNGATED obligations on devices — they send immediately, documented by the
  existing "copied project notification intent" test.
- **Existing devices' subscriptions** keep the old one-type filter until
  their next enroll/push-token-update re-arms the rule (the mobile app
  re-enrolls on launch), so suppression activates per device organically.
- Notification-intent contract bumped 0.1.0 → 0.2.0 (additive optional
  field); device contract 0.4.0 → 0.5.0 (state shape change refolds caches).
