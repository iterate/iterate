---
status: in-progress
size: large
branch: mobile-reply-push
---

# Push notification for chat replies you didn't wait for

Send a message to a chat, leave before the reply lands → get a push with the reply. Suppress the push when the reply was seen — in the mobile app **or** the OS web app.

## Status summary

Spec fleshed out and settled (via plannotator grilling, round 1 approved). Implementation not started.

- Done: design decisions below, codebase research.
- Missing: everything else (contracts, producer, device suppression, clients, tests).

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

- [ ] Stamp sender identity: add optional `userId` to the user actor variant in `agentContextItemSchema` (`agent-processor-contract.ts`); populate from `auth.principal` in `AgentRpcTarget.message()`/`ask()` (`rpc-targets.ts` `#contextActor`)
- [ ] `NotificationIntentContract` 0.3.0: `audience` union gains `{kind:"user", userId}`; optional top-level `agentReplyEventOffset`
- [ ] New `agent-reply-presented-contract.ts` catalog (project contract owns/spreads it; device contract consumes via `processorDeps`)
- [ ] New chat-reply-notify sibling processor (contract + implementation) in `apps/os/src/domains/notifications/`; registered via `input.sibling` for plain `agents.create()` threads
- [ ] `DeviceProcessorContract` 0.6.0: consume the claim; `replyGraceMs` config; obligation gains `agentReplyEventOffset`; audience filter on copied intents (skip when `ownerId` mismatch); subscription filter gains the claim event type
- [ ] Device processor implementation: generalize approval grace machinery to cover reply grace; claims mark `presentedAt` on exact `(path, replyEventOffset)` match; settle `suppressed`
- [ ] Mobile: append claim from chat screen when newest assistant message renders foregrounded (model on `in-thread-approval.tsx` useQuery + `appForegrounded`)
- [ ] OS web app: same claim from the web thread view (document-visible gate)
- [ ] Tests: producer node tests (stream-processor harness); device suppression/audience tests next to existing approval-grace tests; e2e following `itx-devices.e2e.test.ts` + `chat-roundtrip.e2e.test.ts` patterns
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`

## Implementation notes

(log kept while implementing)
