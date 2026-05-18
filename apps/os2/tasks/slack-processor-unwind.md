---
state: in_progress
priority: high
size: large
dependsOn: []
---

# Slack Processor Unwind

Unwind OS2 Slack handling so Slack-specific behavior lives in the Slack
processors and Slack domain, not in `AgentDurableObject`.

## Target Shape

- Project-level Slack stream path is `/integrations/slack`.
- Delete `/integrations/slack/webhooks`; no compatibility alias.
- Processor slug is `slack`.
- Hosting Durable Object remains `SlackIntegrationDurableObject`.
- `slack` processor owns integration-level Slack state:
  - connection/lifecycle facts
  - Slack thread key to stream path routes
  - raw Slack webhook events
- `slack` processor auto-generates Slack thread stream paths.
- `slack` processor forwards routed Slack webhooks to the mapped stream.
- `slack` processor appends routed-stream bootstrap events in one batch when
  creating a route:
  - subscription for `slack-agent`
  - subscription for generic `agent`
  - `events.iterate.com/slack/thread-route-configured`
  - `events.iterate.com/slack/webhook-received`
- `slack` processor must not know agent semantics beyond opaque subscription
  descriptors it is configured to append.
- `slack-agent` replaces `slack-thread` as the in-thread Slack processor name.
- `slack-agent` runs on routed Slack streams.
- `slack-agent` owns Slack-specific in-thread behavior:
  - reduce thread context from `slack/thread-route-configured`
  - interpret inbound Slack webhooks
  - run bang-command matching
  - emit codemode script requests for bang commands
  - emit `agent/input-added` for non-bang messages
  - own Slack status and reaction side effects
  - register and satisfy `ctx.slack.agent.*` event-based provider calls
- Bang command scripts inline known Slack `channel` and `thread_ts`.
- Bang command scripts are responsible for posting Slack messages directly with
  `ctx.slack.chat.postMessage(...)`.
- No automatic Slack reply on bang-command completion or error.
- `ctx.slack.chat.postMessage(...)` remains the generic Slack Web API provider.
- `ctx.slack.agent.threadInfo()` is served by `slack-agent` through an
  event-based codemode provider.
- `AgentDurableObject` may no longer contain Slack-specific imports, env vars,
  path checks, token reads, Web API calls, debug formatting, or provider
  handling.

## Implementation Plan

- Add `appendBatch` to `ProcessorStreamApi` as a required method.
- Thread `appendBatch` through shared stream processor runner wrappers and local
  test stream APIs.
- Move OS2 Slack integration stream path from `/integrations/slack/webhooks` to
  `/integrations/slack`.
- Rename shared `slack` processor slug from `slack-integration` to `slack`.
- Add/adjust Slack processor events for integration connection and thread route
  configuration on `/integrations/slack`.
- Teach `slack` to batch append routed stream subscriptions, route context, and
  first webhook.
- Create/rename `slack-agent` processor from current `slack-thread`.
- Move in-thread Slack behavior out of `AgentDurableObject` and into
  `slack-agent` / Slack domain code.
- Add `SlackAgentDurableObject` to host the `slack-agent` processor.
- Configure `slack` routed stream subscription descriptors for
  `SlackAgentDurableObject` and `AgentDurableObject`.
- Move `ctx.slack.agent.threadInfo()` to an event-based provider registered and
  satisfied by `slack-agent`.
- Remove all Slack-specific code from `AgentDurableObject`.
- Update docs and tests to use `/integrations/slack` and `slack-agent`.

## Testing Plan

- Shared processor tests:
  - `slack` reduces connection and route state.
  - `slack` forwards webhooks to generated stream paths.
  - `slack` uses `appendBatch` in the expected order for new routes.
  - `slack-agent` reduces route context.
  - `slack-agent` emits codemode script requests for bang commands.
  - `slack-agent` emits `agent/input-added` for non-bang Slack messages.
  - `slack-agent` satisfies `ctx.slack.agent.threadInfo()` function calls.
- OS2 tests:
  - focused typecheck for new Durable Object bindings and callable descriptors.
  - existing OS2 unit tests.
  - workerd test if the Durable Object wiring needs runtime coverage.
- Local Slack smoke:
  - use Doppler-provided OS2 Slack bot token without printing it.
  - verify Slack auth through `SlackCapability`.
  - append a representative Slack webhook to `/integrations/slack`.
  - verify route setup and forwarded events on the routed stream.
  - manually append `async (ctx) => ctx.slack.agent.threadInfo()` and verify it
    completes through event-based provider handling.
  - run a bang command and verify the script posts to Slack.

## Implementation Notes / Decisions / Issues

- Decision: no backwards compatibility for `/integrations/slack/webhooks`.
- Decision: `SlackIntegrationDurableObject` remains the Durable Object name.
- Decision: processor slug should be `slack`.
- Decision: in-thread processor should be called `slack-agent`, not
  `slack-thread`.
- Decision: `slack` auto-generates routed stream paths.
- Decision: `slack` appends subscription events itself as processor logic.
- Decision: use `appendBatch` for routed stream bootstrap when available; make it
  part of `ProcessorStreamApi`.
- Decision: create a separate `SlackAgentDurableObject` now.
- Decision: `slack` subscribes both `SlackAgentDurableObject` and generic
  `AgentDurableObject` to routed streams.
- Decision: `ctx.slack.agent.threadInfo()` is the Slack-agent context helper.
- Decision: bang command scripts do not return values and do not get an
  automatic result-posting wrapper. Any Slack message must be sent by the script
  itself with `ctx.slack.chat.postMessage(...)`.
- Implemented: `ProcessorStreamApi.appendBatch` is required and threaded through
  the shared runner wrappers, OS2/app stream APIs, and test helpers.
- Implemented: shared `slack` processor slug is `slack`; it reduces connection
  state, keeps route state, and uses `appendBatch` for routed-stream bootstrap.
- Implemented: shared `slack-agent` processor replaces `slack-thread`; it
  reduces route context, registers `ctx.slack.agent`, handles bang matching,
  transcribes non-bang webhooks, handles Slack status/reaction side effects, and
  satisfies `ctx.slack.agent.threadInfo()` event calls.
- Implemented: OS2 has a separate `SlackAgentDurableObject`; routed stream
  subscription delivery can lazy-initialize both `SlackAgentDurableObject` and
  generic `AgentDurableObject` from their structured Durable Object names.
- Implemented: `AgentDurableObject` has no Slack-specific imports, env vars,
  path checks, token reads, Web API calls, debug formatting, or provider
  handling.
- Implemented: `SlackIntegrationDurableObject` can lazy-initialize from its
  structured runtime name when a stream subscription delivers `afterAppend`.
- Implemented: codemode script execution no longer re-enters live catch-up
  before running a requested script. This fixed the live first-bang case where
  the script request was reduced to `requested` but never executed.
- Verification so far: `pnpm --dir packages/shared test:stream-processors --
--runInBand` passed; `pnpm --dir apps/os2 typecheck` passed.
- Verification update: root `pnpm typecheck`, `pnpm format:check`, `pnpm
lint`, `pnpm knip`, `pnpm --dir packages/shared test`, and `pnpm --dir
apps/os2 test` passed.
- Verification update: `pnpm --dir apps/agents test` and `pnpm --dir
apps/events test` passed after updating their shared processor API/docs
  references and cleaning the stale apps/events route tree/knip config.
- Kimi update: replaced prior Kimi K2.5 references with
  `@cf/moonshotai/kimi-k2.6`. OS2 now defaults new agents, new presets, shared
  agent reduced state, and unconfigured agent runtime setup to Cloudflare
  AI/Kimi K2.6 instead of OpenAI WebSocket.
- Verification: `pnpm --dir apps/os2 test` and focused shared/agents/events suites passed for the processor refactor work described above.
- Real-token check: `doppler run --project agents --config dev -- ... Slack
auth.test` succeeded against the iterate Slack workspace without printing the
  token. OS2 Doppler dev config in this checkout did not expose
  `APP_CONFIG_SLACK_BOT_TOKEN`, so a full local OS2 Slack smoke needs either the
  token copied into OS2 dev config or a preview/prod OS2 deployment that already
  has it.
- Local tunnel proof: restarted the OS2 dev worker at
  `https://os.iterate-dev-jonas.com` with the agents dev Slack bot token
  preserved into the OS2 env. The focused e2e
  `routes Slack webhooks into slack-agent streams and executes bang command
replies` passed against that tunnel. It posts a real root Slack message,
  appends a representative bang-command webhook to `/integrations/slack`, then
  verifies the routed stream has `slack-agent` and `agent` subscriptions,
  `slack/thread-route-configured`, `ctx.slack.agent` registration,
  `codemode/script-execution-requested`, and a completed
  `slack.chat.postMessage` call returning Slack `ok: true`.
- Local Kimi proof: against `https://os.iterate-dev-jonas.com`, the focused e2e
  `uses Kimi K2.6 through Cloudflare AI for unconfigured agent chats by default`
  passed. It sends a chat message to a new unconfigured OS2 agent and verifies a
  successful `cloudflare-ai` LLM request with model
  `@cf/moonshotai/kimi-k2.6`, an `agent/output-added` event, and no
  `openai-ws/llm-request-started` event.
