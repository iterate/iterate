# Agents + Slack + OpenCode Architecture

## Services and ownership

- `slack-service`
  - Receives external Slack webhooks.
  - Appends ingress events to Event Bus (`/integrations/slack/webhooks`).
  - Owns Slack thread routing table (SQLite).
  - Decides when to create agents (pure decision function + debug procedure).
  - Fans prompt events out to mapped agent streams.
  - Consumes agent stream events over Event Bus websocket subscriptions and posts back to Slack API.
  - Exposes `/codemode` to run JS against a Slack context.
- `agents-service`
  - Slack-agnostic agent provisioning.
  - `get-or-create` creates/loads provider session metadata.
  - Registers provider push subscription (`opencode-wrapper` callback).
  - Exposes transparent stream proxy endpoints (`append`, `registerSubscription`, `ack`, `stream`).
- `opencode-wrapper-service`
  - Creates provider sessions.
  - Consumes `agents/prompt-added` events.
  - Emits `agents/status-updated`, `agents/response-added`, `agents/error`.
- `daemon-service`
  - Out of path in this architecture.

## Runtime flow

1. Slack webhook -> `slack-service /webhook`.
2. Slack service normalizes payload and appends ingress event to Event Bus.
3. Event Bus push callback -> `slack-service /internal/events/integrations`.
4. Slack service loads routes for `(workspace, channel, thread_ts)`.
5. Slack decision engine runs:
   - If no route and message is eligible: create agent.
   - If route exists: append prompt only.
   - If message ignored: no-op.
6. If create required, Slack calls `agents-service /api/agents/get-or-create`.
7. Agent service creates provider session in OpenCode Wrapper (if needed), stores mapping, registers provider subscription.
8. Slack persists thread -> agent mapping and ensures websocket subscription for each mapped agent stream.
9. Slack appends `agents/prompt-added` to each mapped agent stream.
10. OpenCode Wrapper processes prompt and appends agent status/response/error events.
11. Event Bus websocket pushes those events to Slack service (`/internal/ws/agent-events`).
12. Slack service dedupes by `(stream_path, offset)` and posts messages to Slack thread.

## Decision engine

- Pure function: `services/slack/src/decision.ts`
  - `decideSlackWebhook(input)`
  - Input: normalized webhook + existing routes.
  - Output: `shouldCreateAgent`, `shouldAppendPrompt`, optional `getOrCreateInput`, reason codes, debug payload.
- Debug procedure: `POST /api/slack/debug/decide-webhook`
  - Dry-run only. No side effects.
  - Useful for testing and production debugging of route/create logic.

## Slack codemode

- Endpoint: `POST /codemode`
- Input: `{ agentPath, code }`
- Resolves Slack thread context by `agentPath` from routing table.
- Runs async JS with bindings:
  - `slack.sendMessage(text)`
  - `slack.callApi(method, payload)`
  - `session` (agent/thread metadata)
  - `globalThis`

## Persistence

`slack-service` SQLite tables:

- `slack_thread_agent_routes`
  - Key: `(workspace_id, channel, thread_ts, agent_path)`
  - Fields include provider session id, stream path, subscription slug.
- `slack_outbound_offsets`
  - Key: `(stream_path, offset)`
  - Prevents duplicate Slack posts.

`agents-service` SQLite tables:

- `agent_provisioning`
  - Key: `agent_path`
  - Stores provider, session id, canonical stream path.

## Main API surfaces

- Slack:
  - `POST /webhook`
  - `POST /internal/events/integrations`
  - `POST /api/slack/debug/decide-webhook`
  - `POST /codemode`
- Agents:
  - `POST /api/agents/get-or-create`
  - `POST /api/agents/streams/{+path}`
  - `POST /api/agents/streams/{+path}/subscriptions`
  - `POST /api/agents/streams/{+path}/subscriptions/{subscriptionSlug}/ack`
  - `GET /api/agents/streams/{+path}`
- OpenCode Wrapper:
  - `POST /new`
  - `POST /internal/events/provider`
