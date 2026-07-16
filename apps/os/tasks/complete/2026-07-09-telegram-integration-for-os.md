---
state: done
priority: high
size: large
dependsOn: []
---

# Telegram Integration for OS

Captured: 2026-07-08. Fleshed out by an agent while Misha is AFK — assumptions
are marked **(assumption)** throughout; everything else follows directly from
the existing Slack/GitHub/Google integration machinery.

## Status summary

Part 1 (the integration) is DONE — implemented, CI fully green, and verified
end-to-end by Misha from his phone against preview-2 (BotFather token pasted
in the dashboard, message sent to the bot, agent replied in the chat). All
pieces landed: URL secret substitution, connect/status/disconnect flows,
webhook door (plus the ingress lane fix), router + agent processors, itx
dispatch + `connectTelegram` verb, system prompt via agent-defaults,
dashboard card, four new test files.

Parts 2 and 3 (threading + steal-with-confirm, bundled into the same PR at
Misha's request) are implemented, CI-green, and deployed to preview-2: `/new`
session rotation (+ setMyCommands + fixed ack + trailing text), reply_to as a
router-resolved agent hint, the `send-requested`/`message-sent`
journaled-send pair with the deterministic reply_to_message_id rule, and
`connectTelegram({ steal })` with the dashboard confirm dialog. PR marked
ready for review 2026-07-09 at Misha's request; phone-side spot checks of
Parts 2–3 can happen on the preview or post-merge.

## Objective

Add a `telegram` built-in integration mirroring the Slack integration shape:

- A project connects one or more Telegram bots (token from @BotFather).
- Inbound Telegram updates arrive on a webhook, are verified, routed via the
  deployment-wide connection directory, and appended to
  `/integrations/telegram/<connection>`.
- A router processor forwards each chat's updates to a per-chat agent stream;
  an agent processor transcribes messages into agent context and the agent
  replies via the bot API.
- Agents and itx scripts get `itx.integrations.telegram.get("<connection>")` for
  arbitrary Bot API calls (`sendMessage`, `sendChatAction`, …), token
  substituted at the egress door — material never read back.

## Design decisions

### No OAuth — bot-token paste + `setWebhook`

Telegram has no OAuth. Connect is: user pastes the BotFather token into the
integrations UI → we validate with `getMe` → store the token in a Secret DO →
call `setWebhook` → record the connection. So Telegram does NOT go through
`startOAuthFlow`/`completeConnect`; it gets its own itx verb
`connectTelegram({ botToken })` **(assumption: a dedicated verb is cleaner
than contorting the OAuth state machinery for a flow with no redirect)**.

- Connection name: sanitized bot username (e.g. `mishas-helper-bot`), falling
  back to `bot-<botId>`; reconnects reuse the claiming connection's name (same
  rule as Slack).
- Directory external id: the numeric bot id from `getMe` (stable even if the
  username changes).
- Secret: bare token string at
  `/secrets/integrations/telegram/<connection>/bot-token`, egress pinned to
  `https://api.telegram.org`.

### Webhook routing: per-bot URL + stateless secret token

Telegram `Update` payloads do not identify the bot, so the bot id goes in the
webhook path: `/api/integrations/telegram/webhook/<botId>`. Verification uses
Telegram's `X-Telegram-Bot-Api-Secret-Token` header (static compare, no HMAC
over the body). The secret token is **derived, not stored**:
`hmac(SECRET_ENCRYPTION_KEY, "telegram-webhook:<botId>")` — both the connect
flow (which passes it to `setWebhook`) and the webhook door (which verifies
the header) can compute it statelessly, same spirit as `oauth-state.ts`. Hex
output satisfies Telegram's 1–256 chars of `[A-Za-z0-9_-]`.
**(assumption: derived beats stored — no new Doppler secret needed in any
environment, which also means previews work with zero config changes.)**

Door behavior mirrors GitHub/Slack: bad/missing secret token → 401, valid but
unclaimed bot id → 200 ACK-and-drop, unparseable → 200 ACK-and-drop. Dedupe
idempotency key: `telegram-webhook:<botId>:<update_id>` (Telegram retries
deliveries; `update_id` is the delivery identity).

### Outbound calls: extend secret substitution to the URL path

The Bot API puts the token in the URL (`https://api.telegram.org/bot<token>/
sendMessage`) — there is no header auth. Today the egress door substitutes
`getSecret({...})` placeholders in **headers only** (`domains/secrets/utils.ts`).
Extend the substitution to also rewrite placeholders in the request URL, in the
Secret DO's trusted code, with tests. Then `callProjectTelegramBotApi` mirrors
`callProjectSlackWebApi`: POST to
`<apiBase>/botgetSecret({ path: ".../bot-token" })/<method>` through the
project egress door. **(assumption: extending URL substitution is the right
seam — it's small, generic, and keeps the write-only-material invariant.)**

### Processors: router + agent pair, closely following Slack

- `TelegramProcessor` (router) on `/integrations/telegram/<connection>`,
  armed at connect time via the shared `recordConnection`
  `processorSubscription`. Routes each update by chat to
  `/agents/telegram/<connection>/chat-<chatId>` (append
  `/topic-<message_thread_id>` for forum supergroup topics) and forwards the
  raw webhook event unchanged. Adds no reactions at router level
  **(assumption: skip the Slack 👀-equivalent for v1; `sendChatAction`
  "typing" from the agent processor covers acknowledgement)**.
- `TelegramAgentProcessor` on the routed stream: transcribes update payloads
  (`message.text`, sender, chat title) into `agents/context-added`, sends
  `sendChatAction: typing` while the agent LLM is working, and instructs the
  agent (system prompt in `project-processor-implementation.ts`, alongside the
  Slack one) to reply with
  `itx.integrations.telegram.get("<connection>").sendMessage({ chat_id, text })`.
- v1 scope: text messages only. Photos/voice/stickers/edits are transcribed as
  a bracketed placeholder like `[photo]` **(assumption)**.
- Ignore updates from bots (`message.from.is_bot`) to prevent loops.

### Deployment config

None required — this is the point of the derived webhook secret. Optionally
`integrations.telegram.apiBaseUrl` if tests/e2e need to point the connect flow
and outbound calls at a fake Bot API server (follow whatever pattern
`slack-api.ts` tests use for egress; prefer dependency injection over mocks).

## Touch points

- [x] `types.ts` + `utils.ts`: add `"telegram"` to `BuiltinIntegrationSlug` /
      `BUILTIN_INTEGRATION_SLUGS`; event type constants; secret/thread path
      helpers (`telegramBotTokenSecretPath`, `telegramChatStreamPath`,
      `telegramConnectionFromAgentPath`) — _done; also added
      `telegramChatIdFromAgentPath` (the prompt embeds the chat id) and
      `telegramWebhookSecretToken` (the derived setWebhook/door secret), plus a
      new `OAuthProviderSlug = Exclude<BuiltinIntegrationSlug, "telegram">` so
      the OAuth-only verbs stay exhaustively typed_
- [x] `domains/secrets/utils.ts`: URL-path placeholder substitution + tests —
      _`secretReferencesFromRequest` / `secretReferencePathsFromRequest` /
      `substituteSecretRequest` (headers + decoded URL; placeholder-free URLs
      pass through byte-identical); Secret DO + project egress door switched to
      the request-level functions; ADR 0005 + design doc reworded to
      "envelope, never the body"_
- [x] `connect-flows.ts`: `connectTelegram` (getMe → claim check → secret →
      setWebhook → `recordConnection`), `getConnectionStatus` +
      `disconnectProvider` arms (disconnect calls `deleteWebhook` best-effort,
      then shared `recordDisconnection`) — _done; throws human-readable errors
      (direct RPC verb, not a redirect chain); egress pinned to the config's
      Bot API origin_
- [x] `telegram-webhook.ts` + register in `integration-webhook-api.ts`
      handler chain — _`createTelegramWebhookFetch(deps)` DI factory (fake
      router + fixed key in tests, real halves in prod); 401 on bad secret
      token, ACK-and-drop otherwise; idempotency key
      `telegram-webhook:<botId>:<update_id>`_
- [x] `telegram-api.ts`: `callProjectTelegramBotApi` via egress substitution —
      _placeholder in the URL path (`/bot<placeholder>/<method>`), POST JSON
      through the project egress door; secret-pipeline errors named per
      connection like slack-api_
- [x] `telegram-processor-contract.ts` / `-implementation.ts` (router),
      `telegram-agent-processor-contract.ts` / `-implementation.ts`; register
      on the project + agent Durable Objects next to the Slack pair — _router
      is stateless (chat id is a pure function of the update, unlike Slack's
      route table); agent processor transcribes updates to YAML agent context
      with `[photo]`-style media placeholder notes, ignores bot-authored
      updates, sends `sendChatAction: typing` after input commit and on
      llm-request/script-execution events_
- [x] `project-processor-implementation.ts`: telegram agent path detection +
      system prompt — _`telegramAgentSystemPrompt({ connection, chatId })`
      (chat id parsed from the agent path so replies need no payload
      spelunking); birth certificate arms `telegram-agent` on
      `/agents/telegram/**`_
- [x] `rpc-targets.ts`: `itx.integrations.telegram.get("<connection>").<method>`
      dispatch branch + the `connectTelegram` verb reachable from the
      dashboard — _flat one-segment method dispatch with `__describe` +
      TELEGRAM_CALL_GRAMMAR; `connectTelegram` verb; itx-api regenerated;
      `connectTelegram` added to the provideCapability collision guard_
- [x] Dashboard integrations page: Telegram card with token-paste connect
      dialog (no OAuth redirect), disconnect, status — _`TelegramItem` card
      with a Sheet + single token field (uncontrolled input, tanstack
      mutations; sheet-open useState mirrors the existing
      AccountConnectionsItem precedent); notes group privacy mode in the
      field description_
- [x] Tests: mirror `slack-processors.test.ts` (router + agent pair),
      webhook door tests (secret token, unclaimed bot, dedupe), connect flow
      tests with a fake Bot API (no `vi.mock`), URL substitution tests —
      _`telegram-processors.test.ts` (in-memory stream network, real
      processors), `telegram-webhook.test.ts` (DI'd door, no module mocks),
      `telegram-connect.test.ts` (REAL local HTTP fake Bot API via the config
      apiBaseUrl knob; the itxEnv storage seam does use `vi.mock` — the exact
      precedent of github-connect/google-connection tests, since itxEnv is a
      module-level workerd binding), URL substitution in
      `secrets/utils.test.ts`_

## Manual test plan (phone-friendly, against the preview)

1. In Telegram, talk to `@BotFather` → `/newbot` → copy the token.
2. Open the preview OS URL (see the PR's Environment Config Lease section),
   sign in, open/create a project.
3. Integrations → Telegram → paste token → Connect. Expect the card to show
   the bot username as connected.
4. In Telegram, open the bot chat (BotFather gives a `t.me/...` link), send it
   a message. Expect a typing indicator and then an agent reply.
5. Reply again in the same chat — same agent stream continues the
   conversation.

Part 2 (threading) addendum:

6. Send `/new` (it should appear in the `/` command menu). Expect the fixed
   "Started a fresh thread." acknowledgement, no agent greeting, and fresh
   context (ask something referencing the earlier conversation — the agent
   should not know it).
7. Send `/new plan something` — expect the fixed ack AND an agent answer to
   the trailing text as the new thread's first message.
8. Reply (swipe-to-reply) to one of the bot's messages from BEFORE the `/new`.
   Expect the agent's answer to acknowledge/reference the old thread (its
   input carries the old session's stream path).
9. While the agent is working on one question, send another message, then
   check the answer to the first: it should quote (reply to) the message it
   answers; answers to the latest message should NOT quote.

Part 3 (steal) addendum:

10. In a SECOND project, Integrations → Telegram → paste the SAME bot's token
    → Connect. Expect the "already connected to another project" confirm
    dialog (not a dead-end error).
11. Confirm the steal. Expect the new project's card to show the bot
    connected, and the FIRST project's card to show it disconnected; messages
    to the bot now reach the new project's agents.

## Risks / open questions

- URL secret substitution is the one change outside the integrations domain —
  keep it minimal and well-tested; flag in the PR for review.
- `setWebhook` requires an HTTPS URL reachable by Telegram — fine for
  previews/prod; local dev needs captun or a tunnel (document, don't solve).
- Telegram group privacy mode: bots in groups only see commands/mentions by
  default. v1 targets direct messages; note in the UI copy or PR body.
- Rate limits (~30 msg/s global, 1 msg/s per chat) — ignore for v1.

## Part 2: threading — /new sessions, reply hints, journaled sends

Designed with Misha on the PR, 2026-07-09. v1 routes every DM to one agent
stream forever; this adds thread semantics from Telegram's actual primitives.

### `/new` rotates the session — the ONLY routing rule

- Session streams: `/agents/telegram/<connection>/chat-<chatId>/session-<unixSeconds>`,
  named by the `/new` message's `date`. Order sessions by `(date, message_id)`
  — `date` is unix seconds so ties are possible; `message_id` is strictly
  increasing per chat and breaks them.
- Every inbound update routes to the LATEST session — plain messages never
  route anywhere else; replies do not route either (next section).
- Pre-`/new` history is session zero: the bare `/chat-<chatId>` stream, so
  existing chats behave exactly as v1 until the first `/new`.
- `/new trailing text` starts the session AND transcribes the trailing text
  as its first message.
- `/new` is acknowledged by a FIXED processor-level message for now (not an
  agent greeting) — e.g. "Started a fresh thread." sent via the journaled
  send pair below (decided by Misha).
- The router folds per-chat session starts from its own journal — same shape
  as the Slack router's `routes` table.
- Register the command via `setMyCommands` during `connectTelegram` so the
  `/` menu advertises it (already-connected bots pick it up on reconnect —
  acceptable).
- Forum topics compose: sessions nest under `/topic-<threadId>` the same way.

### reply_to is a HINT to the agent, not a routing rule

Hard-routing replies to old sessions was considered and rejected:
reply-to-quote and reply-to-continue are the same gesture, and a routing rule
cannot disambiguate them — the failure mode is extending the wrong
conversation, invisibly. Instead rely on intelligence:

- The message routes to the latest session like everything else.
- The transcription annotates it: "this replies to <sender>'s message
  (<excerpt>) from thread `<sessionPath>`" — resolved from the provenance map
  (below) for bot messages, falling back to "latest session started at or
  before `reply_to_message.date`" for user messages (`reply_to_message`
  embeds the replied-to message including its `date` — no lookup needed).
- The telegram agent system prompt (agent-defaults.ts) encourages the agent
  to read the referenced stream for context (`itx.streams.get(path)`),
  cross-post its answer there, or simply answer in place — its judgement.

### Journaled sends: `telegram/send-requested` → effect → `telegram/message-sent`

Replace the agent's direct `sendMessage` tool call for chat replies with the
platform's intent/effect idiom (docs/domain-objects-and-stream-processors.md;
`-requested` suffix + `blockProcessorWhile`, same as llm-request-requested):

- `telegram/send-requested` appended to the SESSION stream — carries the
  plain Bot API `sendMessage` payload. The stream it lives on IS its thread
  identity; bot messages never need timestamp inference.
- `TelegramAgentProcessor` consumes it inside `blockProcessorWhile`: call the
  Bot API, then append `telegram/message-sent` with `{ requestOffset,
messageId }`. A request without a marker is an unmet obligation (crash →
  checkpoint held → retried); a marked one is satisfied (replay-safe).
- The effect ALSO appends a claim to the CONNECTION stream —
  `{ messageId, chatId, sessionPath, request: { stream, offset } }` — the
  router can only fold its own journal; this makes reply hints exact for bot
  messages. Cross-posting facts to the folding stream mirrors connect-time.
- `reply_to_message_id` on outbound sends is a deterministic rule (decided by
  Misha): if the message being answered is still the latest inbound in the
  chat at send time, do NOT set it (quote is noise); if newer messages have
  arrived since, DO set it (quote disambiguates). Compare by `message_id`.
- ACCEPTED CAVEAT: at-least-once at the Telegram boundary. A crash between
  the API call and the marker append re-sends on retry (duplicate message in
  the chat). Telegram's sendMessage has no idempotency key, so this cannot be
  fixed in principle; the JOURNAL is exactly-once, the send is not. Do not
  add pretend-dedupe.
- Agent-facing surface: either the agent appends send-requested via
  `itx.streams`, or a thin `reply({ text, ... })` capability mounted on
  telegram agent scopes constructs it (chat_id filled from the path) —
  whichever reads best in the system prompt. Raw
  `itx.integrations.telegram.get("<conn>").sendMessage` stays available for
  arbitrary Bot API use.

### Part 2 touch points

- [x] `utils.ts`: session-aware `telegramChatStreamPath` (+ session parse
      helpers); v1 paths stay valid as session zero — _optional `session`
      param appends `/session-<unixSeconds>` after the chat/topic segments;
      added `telegramTopicIdFromAgentPath` (the send effect passes
      message_thread_id back); the existing connection/chat-id parsers already
      tolerate the extra segment_
- [x] Router (`telegram-processor-implementation.ts` + contract): fold
      per-chat session starts from `/new` messages and `message_id →
sessionPath` from the connection-stream sent-claims; route everything
      to the latest session — _state = `sessionsByChat` (full history per
      chat, ordered `(date, message_id)` with a backwards-roll guard — the
      history serves the reply-date fallback) + `sentMessages`
      (`chatId:messageId → sessionPath`); reply hints resolved AT THE ROUTER
      (where the folded state lives) and attached to the forwarded payload as
      `replyHint`; hints for the routing destination itself are suppressed as
      noise, as is the forum-topic-starter pseudo-reply Telegram puts on every
      topic message_
- [x] Agent processor (`telegram-agent-processor-implementation.ts` +
      contract): consume `send-requested` (blockProcessorWhile: send → marker + connection-stream claim + deterministic reply*to_message_id);
      reply-hint annotation in transcription; `/new` fixed acknowledgement +
      trailing-text handling — \_new deps: `agentPath` (chat/topic/connection
      derive from it) and `sendTelegramMessage` (THROWS on failure — the
      obligation depends on it; typing stays best-effort on the swallowing
      dep). Replay safety reads the journal for the request's marker (markers
      land after their request, so folded state can never see them); the
      reply_to rule compares `answeringMessageId` (latest inbound snapshotted
      at llm-request-requested) against the current latest inbound. Bare
      `/new` acks without waking the LLM; trailing text triggers, with the
      ack's send request appended first so it lands before the answer*
- [x] `agent-defaults.ts`: telegram system prompt gains reply-hint guidance
      (read / cross-post / answer in place) and the send-requested reply
      surface — _prompt takes `agentPath` and embeds the exact
      `itx.streams.get("<path>").append({ type: ".../send-requested" ... })`
      snippet; progress notes ride the same journaled send; scheduled scripts
      keep the direct sendMessage (they outlive sessions)_
- [x] `connect-flows.ts`: `setMyCommands` (`/new` — "Start a fresh thread")
      during `connectTelegram` — _same strictness as setWebhook; reconnects
      refresh the menu_
- [x] Tests: session rotation ordering (same-second tie via message*id),
      pre-/new compatibility, reply-hint resolution (bot message via claim,
      user message via timestamp fallback, reply older than first session →
      session zero), send obligation retry (crash before marker → re-send +
      single marker), reply_to_message_id rule (latest → unset, stale →
      set), `/new` fixed ack + trailing text — \_all in
      telegram-processors.test.ts (now 26 tests) + the marked-request replay
      case (crash AFTER marker → no re-send); connect test asserts the
      setMyCommands call*
- [x] Manual test plan addendum: send `/new`, verify fixed ack + fresh
      context; reply to an old bot message, verify the agent references the
      old thread — _appended to the manual test plan above_

## Part 3: steal-with-confirm for cross-project reconnects

Designed with Misha on the PR, 2026-07-09, after he hit it live: connecting
@misherate2bot to a NEW project dead-ended on "already connected to another
project". A Telegram bot has exactly one webhook, so one bot can only serve
one project at a time — but the person holding the BotFather token is the
bot's owner, and they should be able to MOVE it. Possession of the token IS
the authorization (only the owner has it); the confirmation is a foot-gun
gate, not authz.

- `connectTelegram({ botToken, steal?: boolean })`.
- Without `steal`, an already-claimed-by-another-project bot signals
  DISTINGUISHABLY (not an opaque thrown string) so the UI can react — a
  structured result arm alongside the success shape. The message must not
  leak the holding project's identity ("another project" is all a
  potentially-different-org user should see).
- With `steal: true`: getMe re-validates the token as usual, then the OLD
  project is dispossessed BEFORE the new claim — the shared
  `recordDisconnection` run against the old project/connection (empties its
  secret egress so its stored token is unusable, appends its
  telegram `disconnected` fact so its dashboard shows reality, unclaims the
  directory entry). deleteWebhook is deliberately skipped on the old side —
  the webhook is re-registered for the same bot moments later.
- Same-project reconnects are unchanged (silently reuse the claiming
  connection's name; no signal, no steal needed).
- Dashboard card: when connect answers already-claimed, show a house-style
  confirmation ("This bot is already connected to another project. Steal it?
  The other project will lose the connection.") and retry with
  `steal: true` on confirm.

### Part 3 touch points

- [x] `connect-flows.ts`: `connectTelegram` gains `steal?: boolean` + the
      structured `already-claimed` result arm; steal path dispossesses the old
      project via `recordDisconnection` (no deleteWebhook), then runs the
      normal connect — _`ConnectTelegramResult` union
      (`ok: true` | `ok: false, error: "telegram_bot_already_claimed"` with
      only the bot username, never the holding project); the old project's
      disconnected fact carries `reason: "stolen-by-another-project"`; steals
      derive a FRESH connection name (the old one belonged to the old
      project)_
- [x] `rpc-targets.ts`: verb signature + result type updated; itx-api
      regenerated — _done_
- [x] Dashboard Telegram card: already-claimed → confirm dialog → retry with
      `steal: true` — _house AlertDialog inside TelegramConnectSheet; dialog
      open-state and pending token DERIVE from the mutation's data/variables
      (no extra useState); cancel resets the mutation and returns to the
      sheet_
- [x] Tests: already-claimed signal without steal; steal flips the directory
      claim, empties the old secret's egress, appends old-side disconnected +
      new-side connected facts; same-project reconnect still silent —
      _telegram-connect.test.ts (7 tests): the structured-arm test also pins
      "setWebhook never ran, the other project's claim stands"; the steal test
      pins the full dispossess-then-claim sequence including no old-side
      deleteWebhook_
- [x] Manual test plan: connect the same bot from a second project → confirm
      steal → old project's card shows disconnected, new project gets the bot
      — _appended to the manual test plan_

## Implementation log

- 2026-07-09 (merge #1806/#1807/#1805/#1758-era main): three touchpoints.
  - stream-storage.ts epoch backfill: main's #1806 shipped its OWN in-place
    `alter table subscriptions add column epoch` (pragma table_info guard),
    which SUPERSEDES the interim ALTER fix this branch carried (2b362afba).
    Verified by reading #1806's SqliteSubscriptionCursorStore constructor: it
    creates the table WITH epoch and backfills pre-epoch tables identically
    (default 0). Took main's version wholesale — the interim fix is gone,
    correctly, because the shape it patched is now handled upstream. (#1797,
    the sqlfu version, is still not in main; nothing here pulls it in.)
  - #1807 refold-safe side effects: adapted the telegram-agent processor to
    the pattern main migrated Slack to. The typing chat action is a
    user-visible ACK, so it now gates on the shared `webhookAckIsFresh` (added
    to integrations/utils.ts by #1807; the merge kept both it and the telegram
    event-type constants). The arrival typing stays per-event but
    freshness-gated; the "still working" typing REPAINT moved from a per-event
    `processEvent` case to `processEventBatch` (latest lifecycle fact only,
    at-head, once, with an `#unpaintedTypingFact` carry across lagging folds)
    — same shape as slack-agent's status repaint, fixing the same
    concurrent-closure race and refold replay. Added an injectable `now?` dep.
    The journaled SEND obligation is deliberately NOT freshness-gated: it is a
    durable obligation, not an ack, and is already refold-safe by construction
    (a replayed send-requested finds its journal marker and skips the re-send;
    the marker + claim appends dedupe on idempotency keys). New tests: a full
    stale replay re-transcribes + re-delivers but sends zero typing actions;
    the unpainted-fact carry paints once when the fold reaches head.
  - #1802 event docs: every contract-owned event type now needs an `examples`
    entry (new event-docs test) — added realistic examples for
    telegram/webhook-received, telegram/message-sent, telegram/send-requested.
  - #1805 Drizzle removal / #1758 dual-copy codegen: lockfile merged clean
    (pnpm install no-op); generated files regenerated through the post-#1758
    path (itx-api in apps/os AND packages/iterate, types-source, template map;
    template sdk.ts has no copy marker anymore so it's left as main's
    hand-written re-export). Full typecheck/lint/knip/test green.

- 2026-07-08: worktree + branch `telegram-integration` created off main; spec
  committed before implementation per AFK-task protocol.
- 2026-07-08: URL secret substitution landed first (the one cross-domain
  change): request-level reference scan + substitute in `domains/secrets`,
  matching on the DECODED url (Request construction percent-encodes the
  placeholder's braces/spaces/quotes). Substitution only rewrites URLs that
  actually carry a placeholder, so ordinary URLs never round-trip through
  decode/re-encode. ADR 0005 + integrations design doc updated from
  "header-only, forever" to "envelope (headers + URL), never the body".
- 2026-07-08: core integration landed. Notable choices within the spec's
  latitude:
  - `config.integrations.telegram` defaults to
    `{ apiBaseUrl: "https://api.telegram.org" }` via `.prefault({})` (the
    parent `integrations` object switched `.default({})` → `.prefault({})`
    since `{}` is now input, not output). Zero deployment config still holds.
  - Agent transcription is the FULL update payload as YAML (the Slack
    precedent) plus a bracketed-placeholder summary line for media, rather
    than a reduced text-only transcript — a superset of the spec's
    "text/sender/chat" ask that avoids inventing a lossy reduced shape.
  - `message` and `callback_query` updates trigger the LLM; edits/channel
    posts/membership updates are recorded as `dont-trigger-request` inputs
    (mirrors the Slack non-message lane).
  - Typing action: sent right after the agent context commits (receipt ack —
    Telegram has no reaction primitive) and re-sent on llm-request-requested /
    script-execution-requested (the indicator auto-expires after ~5s).
  - Chat ids are used verbatim in paths (`chat--100123` for supergroups): the
    sign is significant and digits/minus are safe path chars, so no
    sanitization — deliberate difference from Slack's sanitized segments.
  - `startOAuthFlow`/`completeConnect` now take `OAuthProviderSlug` (the old
    trio) instead of `BuiltinIntegrationSlug`, so a stray
    `startOAuthFlow({ provider: "telegram" })` is a type error rather than
    falling into the google branch.
  - github-connect/google-connection tests gained a `vi.mock("./telegram-api.ts")`
    line mirroring their existing slack-api mock (connect-flows → telegram-api
    → projects/egress drags the worker-only entrypoint into Node).
- 2026-07-08 (evening): full-suite sweep exposed three regressions, all fixed:
  - the shared config env-override walker didn't unwrap `ZodPrefault`, so
    `.prefault({})` on the integrations block made every
    `APP_CONFIG_INTEGRATIONS__*` env var throw AT RUNTIME (this would have
    broken the deployed preview outright — same latent hazard existed for the
    email block's documented `APP_CONFIG_EMAIL__ALLOWED_SENDERS`). Fixed in
    packages/shared with a test.
  - `project-repo-template/sdk.ts` drift (regenerated itx-api must be
    re-copied; the lint codegen preset that should do it doesn't fire — the
    template test caught it as designed; re-synced manually).
  - `github-link.test.ts` needed the telegram-api module-graph severing.
- 2026-07-08 (evening): discovered the PR was CONFLICTING with main since
  ~17:45 — which is why the Depot CI runs for the first implementation pushes
  spawned ZERO workflows (no merge ref → no checks, no preview deploy; Misha
  was testing a preview slot that still had none of the telegram code). Merged
  origin/main in (integrations page was redesigned by #1748 — the Telegram
  card re-applied as a `connectControl` node on the new
  ConnectableIntegrationCard, with a token-paste sheet; generated files
  regenerated rather than hand-merged; `StreamEvent.path` from #1745 threaded
  into the test MemoryStream). Post-merge CI then flagged three unused
  telegram exports (knip) — un-exported.
- 2026-07-09: Part 2 (threading) implemented per the agreed spec. Notable
  choices within its latitude:
  - Reply hints are resolved AT THE ROUTER and attached to the forwarded
    payload (`replyHint: { sessionPath, resolvedBy }`): the provenance map and
    session history are router folds, and the agent processor cannot read
    another processor's state. Hints are suppressed when they would name the
    routing destination itself (plain in-thread replies) and for Telegram's
    forum-topic-starter pseudo-replies.
  - The session STREAM is named by the /new message's `date` only
    (`session-<unixSeconds>`); the `(date, message_id)` pair orders the FOLD
    (same-second /new pairs keep one stream, the fold keeps the higher
    message_id, and a duplicate/out-of-order delivery can't roll the live
    session backwards).
  - The `message-sent` event type serves both halves (session marker +
    connection-stream claim) with one schema (`messageId` required, the rest
    optional) — the spec's two payload shapes are projections of one fact.
  - "The message being answered" for the reply_to rule is
    `answeringMessageId`: the latest inbound snapshotted when
    llm-request-requested folds. Comparing it to the current latest inbound at
    send time is exactly "newer messages arrived since", and it's a pure fold
    (no wall clock).
  - Marked-request replay safety reads the JOURNAL for the marker
    (`getEvents` after the request's offset): markers land after their
    request, so folded state at the request's offset can never contain them.
    Crash-before-marker re-sends (the accepted at-least-once caveat, spec'd);
    crash-after-marker never does.
  - The agent reply surface is a raw `itx.streams.get(<own path>).append`
    snippet baked into the system prompt (the spec's "whichever reads best"
    choice) — no new capability plumbing; cross-posting to another thread is
    the same snippet with the other stream's path.
  - The two new event-type constants live on the contracts, not utils.ts
    (contract catalogs need literal keys; knip flagged the unused mirrors).
- 2026-07-09 (later): live-testing + review round-up, all landed:
  - Reply-hint recovery fixed after a live failure: the taught thread-read is
    now FILTERED (eventTypes: webhook-received + send-requested — the
    two-sided transcript) with paging advice, and the hint is imperative and
    LEADS the transcription above the YAML dump. New test seeds a
    real-shaped noisy thread and proves the taught call returns exactly the
    user/bot exchange.
  - Feed rendering: the agent-ui reducer (packages/ui) renders
    telegram/webhook-received as user bubbles (sender username/first name,
    caption + [photo]-style placeholders for media) and
    telegram/send-requested as the assistant bubble — same via-label pattern
    as Slack, schema version bumped to 9 so stale mirrors rebuild.
  - /debug command (mirroring Slack's !debug, compiled straight to a script
    execution — no LLM turn): runs itx.debug() and posts the result through
    the journaled send on the same session stream, truncated to Telegram's
    4096-char limit. Registered in setMyCommands next to /new. Slack's
    general !<expression> compiler deliberately NOT ported — possible
    follow-up.
  - setMyCommands is best-effort (the / menu is cosmetic; its failure must
    never roll back a live webhook — bugbot), and the setWebhook-failure
    rollback gained a best-effort deleteWebhook (defense in depth for
    partial/ambiguous registration failures).
  - Steal ordering refined once more (bugbot): prepare new → atomic swap →
    dispossess old, so no window ever routes to a bricked handler; the old
    project's dashboard is momentarily stale until its disconnected fact
    lands (accepted).
- 2026-07-09: two more bugbot findings folded in (both real):
  - Journaled sends are THREAD-BOUND: payload-supplied
    chat_id/message_thread_id are stripped and the stream-path identity is
    forced (forced, not rejected — a permanently-invalid request must not
    wedge the obligation retry loop). Provenance, not capability: the
    message-sent claim records the stream as the message's thread.
  - connectTelegram is CLAIM-FIRST: recordConnection (secret + facts + arm +
    directory claim) now precedes setWebhook/setMyCommands, so no inbound
    update can ever hit the door unclaimed (ACK-200-drop, never retried).
    setWebhook failure rolls the fresh connection back (best-effort
    recordDisconnection) so the dashboard never shows a half-connected bot.
    Steal's directory swap is ATOMIC: recordConnection's directoryClaim
    gained `unclaimFirst`, batching [unclaim old, claim new] into ONE
    directory append (new appendConnectionDirectoryEvents batch variant) — a
    stolen bot has live traffic throughout, so the unclaimed window had to
    go entirely, not shrink.
- 2026-07-09: URL substitution ratcheted to the PATH segment only (Misha's
  review call): a placeholder in the query/fragment/userinfo/host now throws
  `secret_reference_outside_url_path` at the substitution layer (naming the
  part) instead of silently passing the literal placeholder to the provider.
  The request-level reference SCAN still covers the whole URL on purpose — a
  query-only placeholder must route to the Secret DO to be rejected loudly
  there. ADR 0005 + design docs reworded from "envelope (headers + URL)" to
  "headers + URL path, never query/body". Telegram behavior unchanged (its
  placeholder is in the path — the point of the ratchet).
- 2026-07-09: Part 3 (steal-with-confirm) landed, straight after Misha hit
  the dead end live. connectTelegram answers a ConnectTelegramResult union;
  the dashboard's steal dialog derives entirely from the mutation's
  data/variables (tanstack-style, no extra state); the dispossession reuses
  recordDisconnection against the OLD project (it already takes projectId) —
  no new storage machinery. Two more origin/main merges along the way (the
  recurring generated-file conflict; regenerate, don't hand-merge).
- 2026-07-09: main moved again mid-implementation (the PR silently flipped to
  CONFLICTING — CI runs with an empty merge sha are the tell). Merged
  origin/main: #1784's one-subscription-concept means connectTelegram's wake
  subscription now persists the itx processor expression
  (["integrations", "telegram", ["get", <connection>], "processor"]) and the telegram
  dispatch gained the ProcessorRelayRpcTarget node mirroring Slack's.
- 2026-07-08 (night): CI "Preview / deploy + e2e" flaked once on the new
  births-agents test (timed out right after deploy; passes in ~7s when run
  against the live slot) — re-dispatched, green. Misha verified the round trip
  from his phone on preview-2: connect → message → agent reply. Task moved to
  complete.
