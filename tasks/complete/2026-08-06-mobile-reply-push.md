---
status: done
size: large
branch: mobile-reply-push
---

# Push notification for chat replies you didn't wait for

Send a message to a chat, leave before the reply lands → get a push with the reply. Suppress the push when the reply was seen — in the mobile app **or** the OS web app.

## Status summary

Implementation complete; local checks all green (typecheck, lint, knip, format, full test suite). PR: #2422 (draft).

- Done: all contracts, producer sibling processor, device suppression (grace + claims + claim-before-intent race + per-user audience), mobile + web claim clients, producer/device unit tests.
- Possible follow-ups: reply-specific e2e (the devices e2e covers the delivery pipeline), notifying on threads created before this change (siblings attach at creation only).

## Decisions (settled)

1. **Reuse the existing notification pipeline.** New producer appends `events.iterate.com/notification/requested` to the project root stream; device fan-out, Expo delivery, receipts, and `agent-chat` deep-linking already exist (`apps/os/src/domains/notifications/`, `apps/os/src/domains/devices/`).
2. **Presence claims, not app-lifecycle events.** Copy the `project/approval-presented` pattern: a foregrounded client viewing the thread appends a claim when the reply renders; the device processor holds the push for a grace window and settles it `suppressed` if a claim arrives. No `app/exited` telemetry — direct evidence beats lifecycle inference, works identically for web ("seen in OS app counts" falls out for free), and there's no events ingestion service to build on anyway. Generic mobile lifecycle telemetry = separate future task if wanted.
3. **Trigger scope: any plain chat thread** (created via `agents.create()` — mobile `/agents/mobile/*` and web threads alike), gated on the message having a *user* actor. Sub-agent chatter (`developer` role / agent actor) and integration threads (Slack/Telegram actors, which already notify in-channel) produce nothing. Existing threads don't get the sibling retroactively — new threads only.
4. **Audience: the sender, not the project.** Extend the intent's `audience` union with `{kind: "user", userId}`; device processor skips obligations whose audience doesn't match its `ownerId`. Requires stamping the sender's identity (`auth.principal`) on user `agents/context-added` events — today `actor: {type:"user", origin}` has no userId.
5. **Producer: sibling processor on the agent stream** (Slack/Telegram/Email precedent, `input.sibling` in `agent-defaults.ts`). State machine: latest user-actor message opens a "pending turn" (captures userId); `agents/web-message-sent` with a pending turn emits ONE intent to the root stream and clears it — so multi-message turns coalesce to one push per user turn.
6. **Suppression identity: `(path, replyEventOffset)`.** New claim event `project/agent-reply-presented {path, replyEventOffset}` (standalone catalog, same cycle-breaking pattern as `approval-presented-contract.ts`). Intent carries top-level `agentReplyEventOffset` mirroring `approvalRequestEventOffset`. Exact-offset matching so an old claim can't suppress a newer reply's push.
7. **Grace window: new `replyGraceMs` config knob, default 3000ms** (longer than approvals' 1500ms: claim requires reply render + append round-trip on a possibly-just-woken socket). Reuses the approval-grace alarm machinery, generalized. Read `tasks/complete/*approval-push-suppression*` notes first — there was a fixed race in `releaseApprovalGraces`.
8. **Push content:** title from the agent's latest summary (fallback "Agent replied"), body = reply text truncated ~500 chars. `expiresAt` = reply event `createdAt` + 1h — deterministic from the event, never `now` (redelivery must re-append an identical body).
9. **Web claim ships in this iteration** — it's half the point (idea #1). OS web thread view appends the same claim when the newest reply renders while the document is visible.

## Assumptions made on your behalf

- Web-initiated threads notify too (not just mobile-initiated) — the mechanism lands at the generic `create()` path and per-path filtering seemed artificial. Shout if you want `/agents/mobile/*` only.
- One push per user turn (not per assistant message).
- `auth.principal` is the right user identity to match against device `ownerId` (it's what `devices.enroll` already stamps).
- No unread/badge work (explicitly out of scope, see `tasks/mobile-native-followups.md` §3).

## Checklist

- [x] Stamp sender identity: add optional `userId` to the user actor variant in `agentContextItemSchema` (`agent-processor-contract.ts`); populate from `auth.principal` in `AgentRpcTarget.message()`/`ask()` (`rpc-targets.ts` `#contextActor`) _(userId rides the user actor; matches devices.enroll's ownerId by construction)_
- [x] `NotificationIntentContract` 0.3.0: `audience` union gains `{kind:"user", userId}`; optional top-level `agentReplyEventOffset` _(notification-intent-contract.ts)_
- [x] New `agent-reply-presented-contract.ts` catalog (project contract owns/spreads it; device contract consumes via `processorDeps`) _(claim payload is `{path, replyEventOffset}` — per-stream offsets need the pair)_
- [x] New chat-reply-notify sibling processor (contract + implementation) in `apps/os/src/domains/notifications/`; registered via `input.sibling` for plain `agents.create()` threads _(chat-reply-notify-{contract,implementation}.ts; registered in agent-durable-object.ts + rpc-targets create())_
- [x] `DeviceProcessorContract` 0.6.0: consume the claim; `replyGraceMs` config (3s); obligation gains `agentReplyEventOffset`; audience filter on copied intents; subscription filter gains the claim event type _(also added `recentReplyClaims` — see notes)_
- [x] Device processor implementation: generalized grace machinery (`releaseGraces`, `repointGraceAlarm`, shared `obligationGraceUntil`); claims mark `presentedAt` on exact `(path, replyEventOffset)` match; settle `suppressed` _(alarm slice key kept as "device-approval-grace" — armed slices persist across deploys)_
- [x] Mobile: append claim from chat screen when newest assistant message renders foregrounded _(lib/reply-presented.ts `useClaimReplyPresented`; `appForegrounded` moved there, shared with in-thread-approval.tsx)_
- [x] OS web app: same claim from the web thread view (document-visible gate) _(project-stream-view.tsx `useClaimReplyPresented` — SQLite max-offset query + connectItx append)_
- [x] Tests: producer node tests (8, chat-reply-notify.test.ts); device suppression/audience tests (5 new, device-processor.test.ts) _(reply-specific e2e left as possible follow-up; the devices e2e already exercises the delivery pipeline)_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test` _(all green; itx-api.generated.ts regenerated for the actor/audience contract changes)_

## Implementation notes

- **Claim-before-intent race** (not present in the approval design): a reply's claim and its intent are both triggered by the same `web-message-sent` event, so a client watching the thread can get its claim onto the root stream before the producer's intent — and both ride the same ordered root→device subscription lane. Losing that race would ring a phone the user is actively looking at. Fix: the device processor remembers reduced claims in `state.recentReplyClaims` (bounded: 10min retention / 50 entries, pruned deterministically at reduce), and an intent that arrives after its claim opens pre-claimed (`presentedAt` set). Approvals keep their existing accepted-race behavior — their request always commits long before a client can render the batch.
- **Coalescing**: the producer keys on "reply that closes an open user turn" — consecutive assistant messages in one turn yield ONE push (the first reply closes the turn), and agent↔agent traffic (developer role) never opens a turn.
- **Audience plumbing**: `auth.principal` (a string; what devices.enroll already stamps as `ownerId`) now rides user context-added actors as `userId`. Admin/CLI-sent messages stamp a principal that matches no device → no push (acceptable; better than spamming everyone).
- **Deterministic intent bodies**: `expiresAt` = reply event `createdAt` + 1h, title from folded `agent/summary-updated`, body = reply truncated at 500 chars — a redelivery re-appends the identical body and dedupes on the idempotency key.
- **Migration**: existing threads don't get the sibling (subscriptions are configured at creation); existing devices pick up the widened subscription filter (with the claim event type) on their next enroll → `push-token-updated` re-arm, i.e. next app open.
- Sibling registration reuses `agentCreationForPath`'s existing single `sibling` slot — plain `create()` passed none before. Integration threads (Slack/Telegram/Email) are born elsewhere and unaffected.
