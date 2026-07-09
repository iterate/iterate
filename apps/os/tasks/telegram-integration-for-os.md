---
state: in-progress
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

Part 2 (threading — spec below, bundled into the same PR at Misha's request)
is NOT started: `/new` session rotation, reply_to as an agent hint, and the
`send-requested`/`message-sent` journaled-send pair.

## Objective

Add a `telegram` built-in integration mirroring the Slack integration shape:

- A project connects one or more Telegram bots (token from @BotFather).
- Inbound Telegram updates arrive on a webhook, are verified, routed via the
  deployment-wide connection directory, and appended to
  `/integrations/telegram/<connection>`.
- A router processor forwards each chat's updates to a per-chat agent stream;
  an agent processor transcribes messages into agent inputs and the agent
  replies via the bot API.
- Agents and itx scripts get `itx.integrations.telegram["<connection>"]` for
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
  (`message.text`, sender, chat title) into `agent/input-added`, sends
  `sendChatAction: typing` while the agent LLM is working, and instructs the
  agent (system prompt in `project-processor-implementation.ts`, alongside the
  Slack one) to reply with
  `itx.integrations.telegram["<connection>"].sendMessage({ chat_id, text })`.
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
      route table); agent processor transcribes updates to YAML agent input
      with `[photo]`-style media placeholder notes, ignores bot-authored
      updates, sends `sendChatAction: typing` after input commit and on
      llm-request/script-execution events_
- [x] `project-processor-implementation.ts`: telegram agent path detection +
      system prompt — _`telegramAgentSystemPrompt({ connection, chatId })`
      (chat id parsed from the agent path so replies need no payload
      spelunking); birth certificate arms `telegram-agent` on
      `/agents/telegram/**`_
- [x] `rpc-targets.ts`: `itx.integrations.telegram["<connection>"].<method>`
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
  `itx.integrations.telegram["<conn>"].sendMessage` stays available for
  arbitrary Bot API use.

### Part 2 touch points

- [ ] `utils.ts`: session-aware `telegramChatStreamPath` (+ session parse
      helpers); v1 paths stay valid as session zero
- [ ] Router (`telegram-processor-implementation.ts` + contract): fold
      per-chat session starts from `/new` messages and `message_id →
    sessionPath` from the connection-stream sent-claims; route everything
      to the latest session
- [ ] Agent processor (`telegram-agent-processor-implementation.ts` +
      contract): consume `send-requested` (blockProcessorWhile: send → marker + connection-stream claim + deterministic reply_to_message_id);
      reply-hint annotation in transcription; `/new` fixed acknowledgement +
      trailing-text handling
- [ ] `agent-defaults.ts`: telegram system prompt gains reply-hint guidance
      (read / cross-post / answer in place) and the send-requested reply
      surface
- [ ] `connect-flows.ts`: `setMyCommands` (`/new` — "start a fresh thread")
      during `connectTelegram`
- [ ] Tests: session rotation ordering (same-second tie via message_id),
      pre-/new compatibility, reply-hint resolution (bot message via claim,
      user message via timestamp fallback, reply older than first session →
      session zero), send obligation retry (crash before marker → re-send +
      single marker), reply_to_message_id rule (latest → unset, stale →
      set), `/new` fixed ack + trailing text
- [ ] Manual test plan addendum: send `/new`, verify fixed ack + fresh
      context; reply to an old bot message, verify the agent references the
      old thread

## Implementation log

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
  - Typing action: sent right after the agent input commits (receipt ack —
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
- 2026-07-08 (night): CI "Preview / deploy + e2e" flaked once on the new
  births-agents test (timed out right after deploy; passes in ~7s when run
  against the live slot) — re-dispatched, green. Misha verified the round trip
  from his phone on preview-2: connect → message → agent reply. Task moved to
  complete.
