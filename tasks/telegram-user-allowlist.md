---
status: ready
size: medium
---

# Telegram user allowlist

## Status

Implementation is roughly 95% complete. Durable deny-by-default policy, router enforcement, deterministic denial replies, public RPC methods, and the dashboard editor are implemented and locally verified. Remaining work is preview CI/review follow-up and final task completion bookkeeping.

## Goal

A connected Telegram bot must not grant project-agent access to every Telegram user who can find it. Each connection has an explicit allowlist of immutable Telegram user IDs. New and existing connections default to denying every user until a project owner adds an ID.

## Decisions and assumptions

- Telegram numeric user IDs are the authority. Usernames may be displayed as context but are not authorization because they can change ownership.
- Store the current allowlist in the existing event-sourced integration journal at `/integrations/telegram/<connection>`, matching the email sender-allowlist precedent. A replacement-style access-policy event makes additions and removals explicit and replayable; tokens remain in write-only secret storage.
- Authorization happens in the Telegram connection router before session selection, agent creation, or webhook forwarding. A denied update must never reach an agent stream or trigger an LLM request.
- A private message or callback query with a sender ID may receive one deterministic Bot API response. Updates without a usable human sender ID are denied silently.
- The denial message contains: a clear denial, the resolution, the exact numeric user ID, and an authenticated dashboard deep link that opens this connection's allowlist editor.
- The dashboard link is built from the deployment base URL and the immutable project slug read from the project directory. The page identifies the Telegram connection through a validated search parameter.
- Group authorization remains per sender, not per chat. Bot-authored updates remain ignored.
- This change intentionally defaults existing connections to deny-all. That closes the current exposure immediately; owners bootstrap themselves by messaging the bot, forwarding/opening the returned instructions, and adding the supplied ID.

## Checklist

- [x] Add a contract event and folded Telegram processor state for replacing a connection's allowed user IDs. *`telegram/access-configured` replaces `TelegramProcessorState.allowedUserIds`; an empty/default list denies all.*
- [x] Expose project-scoped RPC methods to read and replace a Telegram connection's allowlist. *`getTelegramAccess` and `setTelegramAccess` validate the connection and wait for the router fold.*
- [x] Reject unauthorized Telegram senders before creating or forwarding to an agent stream. *The connection router checks immutable `from.id` before session routing or agent creation.*
- [x] Send denied users a deterministic, helpful response containing denial, resolution, dashboard deep link, and their numeric user ID. *Fresh ordinary messages get a direct Bot API handoff; historical refolds and sender-less updates stay silent.*
- [x] Add a dashboard allowlist editor for each connected Telegram bot, including deep-link opening and clear numeric-ID guidance. *The integrations page exposes a per-bot access Sheet controlled by `?telegramAccess=<connection>`.*
- [x] Cover authorization, denial response, missing sender identity, allowed routing, policy replacement, and dashboard link construction with focused tests. *Telegram processor coverage exercises the public stream behavior and exact denial body/link.*
- [x] Run focused tests and the repository's pre-PR checks; capture visual evidence for the dashboard change. *Typecheck, lint, format, and the complete monorepo test suite pass; headed browser evidence is included in the draft PR.*
- [ ] Update this task's status/log, move it to `tasks/complete/`, and update the pull request body when complete.

## Implementation log

- 2026-07-17: Chose connection-stream policy events over connection metadata. Connection metadata is a projection of connect/disconnect facts, while access policy is independently mutable operational state; the event-sourced processor is the existing home for comparable email sender authorization.
- 2026-07-17: Added refold freshness protection so deploying deny-by-default does not send denial messages for historical webhook events. Historical unauthorized content remains blocked from agents without generating outbound traffic.
- 2026-07-17: `pnpm --dir apps/os test` passed: 182 files, 1,809 passed, 1 skipped. OS typecheck and focused Telegram tests also passed.
- 2026-07-17: Headed browser QA proved the denial deep link opens the exact bot editor, saving `555`/`777` closes the Sheet with a success toast, and reopening reads the persisted policy back. Screenshot: `docs/pr-assets/telegram-user-access.png`.
- 2026-07-17: The canonical repository checks passed: `pnpm typecheck`, `pnpm lint`, `pnpm format`, and `pnpm test`. The OS unit lane reported 182 files passed with 1,810 tests passed and 1 skipped.
