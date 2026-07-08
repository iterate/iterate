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

Spec committed; implementation not started yet. PR is open as a draft with the
`preview` label so a preview slot deploys — the goal is for Misha to connect a
real BotFather bot from his phone against the preview.

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

- [ ] `types.ts` + `utils.ts`: add `"telegram"` to `BuiltinIntegrationSlug` /
      `BUILTIN_INTEGRATION_SLUGS`; event type constants; secret/thread path
      helpers (`telegramBotTokenSecretPath`, `telegramChatStreamPath`,
      `telegramConnectionFromAgentPath`)
- [ ] `domains/secrets/utils.ts`: URL-path placeholder substitution + tests
- [ ] `connect-flows.ts`: `connectTelegram` (getMe → claim check → secret →
      setWebhook → `recordConnection`), `getConnectionStatus` + 
      `disconnectProvider` arms (disconnect calls `deleteWebhook` best-effort,
      then shared `recordDisconnection`)
- [ ] `telegram-webhook.ts` + register in `integration-webhook-api.ts`
      handler chain
- [ ] `telegram-api.ts`: `callProjectTelegramBotApi` via egress substitution
- [ ] `telegram-processor-contract.ts` / `-implementation.ts` (router),
      `telegram-agent-processor-contract.ts` / `-implementation.ts`; register
      on the project + agent Durable Objects next to the Slack pair
- [ ] `project-processor-implementation.ts`: telegram agent path detection +
      system prompt
- [ ] `rpc-targets.ts`: `itx.integrations.telegram["<connection>"].<method>`
      dispatch branch + the `connectTelegram` verb reachable from the
      dashboard
- [ ] Dashboard integrations page: Telegram card with token-paste connect
      dialog (no OAuth redirect), disconnect, status
- [ ] Tests: mirror `slack-processors.test.ts` (router + agent pair),
      webhook door tests (secret token, unclaimed bot, dedupe), connect flow
      tests with a fake Bot API (no `vi.mock`), URL substitution tests

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

## Implementation log

- 2026-07-08: worktree + branch `telegram-integration` created off main; spec
  committed before implementation per AFK-task protocol.
