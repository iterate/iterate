---
status: in-progress
size: large
---

# In-thread approvals: chat slash commands, approval dialogs in the thread, smarter pushes

## Status summary

Follow-ups from #2337's review (Misha's suggestion block, now in
`tasks/complete/2026-07-29-approval-rejection-reasons.md` › Follow-ups), plus
the chat slash-command enabler discussed after. Nothing implemented yet —
this spec commit comes first.

## Ask (Misha, 2026-07-29)

1. Approvals should appear **inline in a thread** — we trace which thread they
   come from, so they can become a sort of dialog within the chat.
2. The approvals view should show the **status of the thread at the time the
   request was created** — extra context now that the view is mostly history.
3. Only send the push notification **if the user isn't already in the app** —
   give the mobile client ~a second to say "don't worry, I've shown it"; the
   in-thread dialog sends that claim when it renders.
4. Pushes should **jump to the thread**, not the approvals screen.
5. (Think-through only, NOT implementation) how expiry works — pre-approve /
   "request retry" ideas for the woke-up-too-late scenario.
6. (Enabler, from chat) **slash commands** in chat: `/example <slug>` to run a
   catalogue example deterministically, `/script <code>` to hand-jam code —
   so the spec triggers bursts product-shaped from the composer.
7. Restructure `specs/mobile/approvals.spec.ts` around a real chat turn and
   **delete both scoped spinner-waiter disables** — staying in the chat view
   means the agent's working indicator truthfully spans the wait
   (acceptance criterion, per discussion).

## Design

### Slash commands (the enabler, built first)

- No slash support exists anywhere today: every surface (web, Slack, mobile)
  funnels plain text through the ONE inbound door — `agents/context-added`
  with `role: "user"`. That's the choke point: intercept SERVER-SIDE in the
  agent processor when a user context-added event's content starts with a
  known command, BEFORE LLM context assembly. One implementation, every
  surface; the command stays visible in the thread as an ordinary user
  message (audit trail).
- `/example <slug> [json-vars]` — resolve against the ITX examples catalogue,
  run through the capability host's run-script door with this agent's
  script-execution provenance (exactly what the Examples screen does), report
  the result as a visible assistant-side event.
- `/script <code>` — run the given code through the same door. Chat access
  already implies project access, so no new trust boundary; still, both
  commands run with the agent's own provenance so approvals/audit attribute
  correctly.
- Unknown `/commands` fall through to the LLM untouched (people legitimately
  type paths and fractions; only exact known commands intercept).

### In-thread approval dialogs

- Held batches already carry `streamContext.kind === "script-execution"` with
  the originating `streamPath`. When that path is an agent thread, the mobile
  chat screen renders the batch as a DIALOG in the thread: the batch card
  (requests, rule, Approve all / Reject all with reason prompt) inline where
  the conversation is happening — approve without leaving the chat.
- Mechanism: the chat screen already live-tails its agent stream; approvals
  live on the project ROOT stream. The chat screen subscribes to the root
  stream's approval vocabulary filtered to batches whose streamContext points
  at this thread, deriving open batches with the existing
  `deriveOpenBatches`. Decisions reuse `decide()` untouched.
- The approvals screen stays: it becomes the cross-thread queue + history
  view. Batch cards there gain a "thread status at request time" line —
  derived from the agent stream around `scriptRunRequestedEventOffset` (e.g.
  the last user/assistant message before the hold) — cheap context for
  "what was this run even doing".

### Smarter pushes

- Today the notification processor emits one push intent per batch event
  unconditionally, deep-linked to the approvals screen.
- Deep-link change: when the batch's streamContext names an agent thread, the
  intent's destination becomes that thread (`{kind: "agent-chat", path}` +
  the batch offset for focusing the dialog); otherwise it stays `approvals`.
- Suppression: the device processor (delivery layer) gains a short grace
  window (~1s) before dispatching to push channels, during which a client
  that has RENDERED the request in-thread can append a "seen" claim
  (`device/approval-presented` or similar) that cancels delivery for that
  batch. The claim is sent by the mobile chat screen when the in-thread
  dialog actually renders while the app is foregrounded. Design detail to
  settle at implementation: where the delay lives (device processor alarm vs
  notification processor) — pick whichever keeps the notification processor
  stateless-per-event (ADR 0007) or document the exception.

### Expiry / pre-approve (design notes only — decide later, do NOT build)

Scenario: timer-based task needs approval while Misha sleeps; push suppressed
by sleep mode; by morning the hold expired. Options sketched for a future
grilling:
- "Request retry": no-Face-ID button on an expired batch that messages the
  agent "please retry the same request; I'll approve promptly" — leads to a
  fresh batch within seconds. Simple, no new trust semantics.
- "Approve retry": pre-sign an approval for a retry of the exact same request
  set (bind approval.v2 to the request subjects, allow the door to match a
  future identical batch within a TTL). More convenient, but introduces
  standing-approval semantics — needs its own grilling.

## Checklist

- [x] Slash commands: server-side interception at the inbound door;
      `/example` + `/script`; unknown commands fall through; unit tests _slash-commands.ts (pure resolver shared by processEvent + contextTriggerSource, so a resolving command runs deterministically and triggers no model turn); runScriptEnvelope moved into the examples catalogue; resolver unit tests + two harness lanes_
- [x] Mobile chat: in-thread approval dialog (open batches for this thread),
      approve/reject with reason, reusing the approvals lib _components/in-thread-approval.tsx rendered at the inverted list's visual bottom; shares the approvals screen's query key; reject-reason prompt moved to lib/reject-reason.ts_
- [ ] Approvals screen: thread-status-at-request-time context line
- [x] Notification intent: agent-thread destination for thread-scoped batches _notification processor emits {kind: "agent-chat", path} for batches with /agents/ script provenance; approvals destination remains for scope holds_
- [ ] Push suppression: seen-claim + grace window in the delivery layer
- [x] Mobile routing: thread deep-link focuses the in-thread dialog _agent-chat routing already lands on the chat screen, which now renders every open batch for the thread — no focusing param needed_
- [ ] Expiry/pre-approve: design notes written (above), explicitly no code
- [ ] Spec: rewrite around `/example` from the chat composer; DELETE both
      spinner-waiter disables; fresh VIDEO_MODE recording in the PR body
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Web dashboard in-thread dialogs (mobile first; the vocabulary is shared)
- Slack approval dialogs
- Building either expiry/pre-approve option

## Implementation log

- Slash-command trigger suppression is derived from the SAME pure resolver in
  both the event handler and contextTriggerSource — processor and reduce can
  never disagree about whether a message was a command.
- The command's script runs with executionId `slash-command:<offset>`; the
  settled render and activeScriptExecutionIds treat it like an agent-authored
  run, so the result lands in context and drives the agent's next turn — the
  chat's working indicator therefore spans command → run → (approval) →
  result → reply, which is what lets the spec drop its spinner-waiter
  disables.
- Push-suppression design note (not yet built): the seen-claim must reference
  the approval BATCH offset (the client never sees device-stream offsets),
  so the notification intent/device obligation needs to carry it even for
  agent-chat destinations; and the grace expiry needs the device DO's alarm
  to nudge the state-derived send pass. Design carefully before building.
