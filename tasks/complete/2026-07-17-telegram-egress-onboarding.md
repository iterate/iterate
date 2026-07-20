---
status: complete
size: medium
project: prj_5085d38f24af4d27be2337e36d079c2e
stream: /agents/telegram/nustombot/chat-161412593
---

# Teach Telegram agents secret-backed media egress and greet approved users

## Status

Complete. Telegram agents now receive a concise token-safe media download
hint, and newly approved Telegram users receive a proactive welcome. Focused
and full repository verification are green; no production state was changed.

## Scope

- [x] Replace the false Telegram-media limitation with concise instructions for
      `getFile`, secret-backed egress download, and attaching the bytes to agent
      context. Keep bot-token material opaque throughout. _The revision-2
      Telegram system prompt now teaches the production-proven chain._
- [x] Add a regression test proving a Telegram agent is given the usable media
      recipe instead of being told to refuse the task. _Covered in
      `telegram-processors.test.ts`, including the raw `file_id` transcription._
- [x] After Telegram access configuration takes effect, send a short welcome
      message to each newly allowed user through the connected bot. _Implemented
      as the Telegram processor's reaction to the durable access event._
- [x] Do not greet unchanged IDs or removed IDs; a failed welcome must not
      weaken the access boundary or block later traffic. _The processor diffs
      consecutive allowlists and runs each notification on its observable
      non-blocking side-effect lane._
- [x] Add focused tests for first approval, additions, unchanged access, and
      Telegram send failures. _Processor tests cover the access-event reaction
      and prove failed notifications do not block later allowed traffic._
- [x] Run the focused OS test lanes and update this task with the verification
      evidence. _48 focused tests and the 1,826-test OS lane pass; the full
      repository command is green._

## Assumptions

- “Approve a Telegram user id” means adding an ID through
  `itx.integrations.setTelegramAccess`, including the integrations UI that calls
  it.
- The welcome copy is generic and immediately useful, because the access API has
  no authenticated user's display name and bot-specific agent context starts
  only when Telegram ingress creates the chat stream.
- Existing approved IDs are the source of truth for deciding which IDs are new;
  replacing the allowlist does not re-message retained users.
- The production stream itself contains sensitive authorization URLs, so the
  regression captures only the behavioural prompt seam—not vendor tokens,
  signed URLs, or the full journal.

## Production finding

The user had to correct the agent several times before it discovered the
working path:

1. Telegram `getFile({ file_id })` returned `photos/file_0.jpg`.
2. The Telegram connection secret was already allowlisted for
   `api.telegram.org`.
3. A secret placeholder in `itx.egress.fetch` downloaded the file without
   exposing the bot token.
4. The downloaded bytes could then be attached to agent context for vision.

The system prompt simultaneously said incoming media “cannot” be viewed. This
was a prompt/product defect, not an absent platform capability.

## Implementation log

- 2026-07-17: Read the 748-event production journal and reduced it to the
  Telegram transcript. No production state was changed.
- 2026-07-17: Replaced the refusal instruction and stale transcription note
  with a `getFile` / secret-backed egress / `agent.addFiles` hint; bumped the
  prompt revision so existing Telegram agents receive it.
- 2026-07-17: Added proactive welcomes for newly allowed IDs and documented
  Telegram media behaviour.
- 2026-07-17: Verification: focused Vitest 51/51; `pnpm format`; zero-warning
  `pnpm lint`; repository-wide `pnpm typecheck` and `pnpm test`; OS unit result
  1,829 passed, 1 skipped.
- 2026-07-17: Review confirmed the media guidance should remain a short hint
  naming the available primitives.
- 2026-07-18: Review moved the welcome reaction onto the durable
  `telegram/access-configured` event in the Telegram router; the RPC now only
  appends the policy and waits for its access boundary.
- 2026-07-18: Verification after review: focused Vitest 48/48; repository-wide
  format, zero-warning lint, typecheck, and tests; OS result 1,826 passed and 1
  skipped.
- 2026-07-18: Review follow-up made welcomes refold-safe: only fresh access
  events notify users; stale policy replay does not.
