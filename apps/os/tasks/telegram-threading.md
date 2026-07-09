---
state: ready
priority: medium
size: medium
dependsOn: [complete/2026-07-08-telegram-integration-for-os.md]
---

# Telegram threading: /new sessions, reply hints, journaled sends

Captured: 2026-07-09, designed in conversation with Misha on the back of the
v1 Telegram integration (PR #1766). v1 routes every DM to one agent stream
forever (`/agents/telegram/<connection>/chat-<chatId>`); this task adds thread
semantics built from Telegram's actual primitives.

## Status summary

Spec agreed, not started. Three pieces: `/new` session rotation (the only
routing rule), reply_to as an agent hint (not a routing rule), and the
send-requested/message-sent event pair that journals outbound sends and gives
bot messages exact thread provenance.

## Design

### 1. `/new` rotates the session — the ONLY routing rule

- Session streams: `/agents/telegram/<connection>/chat-<chatId>/session-<unixSeconds>`,
  named by the `/new` message's `date`. Order sessions by `(date, message_id)`
  — `date` is unix seconds so ties are possible; `message_id` is strictly
  increasing per chat and breaks them.
- Every inbound update routes to the LATEST session (by that ordering) — plain
  messages never route anywhere else. Replies do not route (see §2).
- Pre-`/new` history is session zero: the bare `/chat-<chatId>` stream. Chats
  that never use `/new` behave exactly as v1.
- `/new trailing text` starts the session AND transcribes the trailing text as
  its first message; bare `/new` just rotates (agent may greet).
- The router folds per-chat session starts from its own journal (webhook
  events it already sees) — same shape as the Slack router's `routes` table.
- Register the command via `setMyCommands` at connect time so Telegram's `/`
  menu advertises it. Add to the existing `connectTelegram` flow (and note:
  already-connected bots only pick this up on reconnect — acceptable).
- Forum topics compose: sessions nest under `/topic-<threadId>` the same way.

### 2. reply_to is a HINT to the agent, not a routing rule

Hard-routing replies to old sessions was considered and rejected:
reply-to-quote and reply-to-continue are the same gesture, and a routing rule
cannot disambiguate them — the failure mode is extending the wrong
conversation, invisibly. Instead rely on intelligence:

- The message routes to the latest session like everything else.
- The transcription annotates it: "this replies to <sender>'s message
  (<excerpt>) from thread `<sessionPath>`" — resolved from the provenance map
  (§3) for bot messages, falling back to "latest session started at or before
  `reply_to_message.date`" for user messages (`reply_to_message` embeds the
  replied-to message including its `date`, so no lookup is needed).
- The telegram agent system prompt (agent-defaults.ts) encourages the agent
  to read the referenced stream for context (`itx.streams.get(path)`),
  cross-post its answer there, or simply answer in place — its judgement.

### 3. Journaled sends: `telegram/send-requested` → effect → `telegram/message-sent`

Replace the agent's direct `sendMessage` tool call for chat replies with the
platform's intent/effect idiom (docs/domain-objects-and-stream-processors.md;
`-requested` suffix + `blockProcessorWhile`, same as llm-request-requested):

- `telegram/send-requested` appended to the SESSION stream — carries the plain
  Bot API `sendMessage` payload. The stream it lives on IS its thread
  identity; no timestamp inference for bot messages ever again.
- `TelegramAgentProcessor` consumes it inside `blockProcessorWhile`: call the
  Bot API, then append `telegram/message-sent` with `{ requestOffset,
messageId }`. The fold treats a request without a marker as an unmet
  obligation (crash → checkpoint held → retried) and a marked one as
  satisfied (replay-safe).
- The effect ALSO appends a claim to the CONNECTION stream —
  `{ messageId, chatId, sessionPath, request: { stream, offset } }` — because
  the router can only fold its own journal; this is what makes reply hints
  exact for bot messages. Cross-posting facts to the stream that folds them
  mirrors connect-time (connection stream + directory).
- ACCEPTED CAVEAT: at-least-once at the Telegram boundary. A crash between
  the API call and the marker append re-sends on retry (duplicate message in
  the chat). Telegram's sendMessage has no idempotency key, so this cannot be
  fixed in principle; the JOURNAL is exactly-once, the send is not. Do not
  add pretend-dedupe.
- The agent-facing surface: either the agent appends send-requested via
  `itx.streams`, or a thin `reply({ text, ... })` capability mounted on
  telegram agent scopes constructs it (chat_id filled from the path). Prefer
  whichever reads best in the system prompt; raw
  `itx.integrations.telegram["<conn>"].sendMessage` stays available for
  arbitrary/advanced Bot API use.

## Touch points

- [ ] `utils.ts`: session-aware `telegramChatStreamPath` (+ session parse
      helpers); keep v1 paths valid as session zero
- [ ] Router (`telegram-processor-implementation.ts` + contract): fold
      per-chat session starts from `/new` messages; fold `message_id →
    sessionPath` from the connection-stream sent-claims; route everything to
      the latest session; emit nothing new otherwise
- [ ] Agent processor (`telegram-agent-processor-implementation.ts` +
      contract): consume `send-requested` (blockProcessorWhile: send → marker + connection-stream claim); reply-hint annotation in transcription;
      `/new` trailing-text handling
- [ ] `agent-defaults.ts`: telegram system prompt gains the reply-hint
      guidance (read / cross-post / answer in place) and the send-requested
      reply surface
- [ ] `connect-flows.ts`: `setMyCommands` (`/new` — "start a fresh thread")
      during `connectTelegram`
- [ ] Tests: session rotation ordering (same-second tie via message_id),
      pre-/new compatibility, reply-hint resolution (bot message via claim,
      user message via timestamp fallback, reply older than first session →
      session zero), send obligation retry (crash before marker → re-send +
      single marker), `/new trailing text`
- [ ] Docs: task file + a short note in the integration's docs about the
      threading model and the at-least-once caveat

## Open questions

- Does the bot-reply UX want `reply_to_message_id` set on sends (Telegram
  quote-reply) so bot answers visually attach to what they answer? Cheap to
  include in send-requested payload; decide during implementation.
- Should `/new` be acknowledged by the agent or by a fixed processor-level
  message? Leaning agent (it has the context to greet usefully).
