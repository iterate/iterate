# Slack Webhook Forwarding Flow

This document describes how Slack webhooks are received, processed, and forwarded to daemon agents.

## Architecture

```
Slack Platform
    │
    ▼
OS Backend (/api/integrations/slack/webhook)
    │
    ├─── 1. Verify Slack signature
    ├─── 2. Handle url_verification challenge
    ├─── 3. Find projectConnection by team_id
    ├─── 4. Save event to database
    │
    ▼ (if webhookTargetMachineId is set)
Machine Forward (via buildMachineForwardUrl)
    │
    ▼
Daemon (/api/integrations/slack/webhook)
    │
    ├─── 5. Extract thread_id from payload
    ├─── 6. Upsert agent (slug: slack-{thread_id})
    ├─── 7. Wait for tmux ready
    └─── 8. Send formatted message to tmux
```

## Components

### OS Backend (apps/os/backend/integrations/slack/slack.ts)

- Receives Slack webhooks at `/api/integrations/slack/webhook`
- Verifies Slack signature for security
- Looks up `projectConnection` by `team_id` to find the associated project
- If `webhookTargetMachineId` is set on the connection, forwards the webhook to the machine's daemon
- Saves all events to the `event` table for audit/replay

### Daemon (apps/daemon/server/routers/slack.ts)

- Receives forwarded webhooks at `/api/integrations/slack/webhook`
- Extracts thread ID from Slack payload:
  - Uses `event.thread_ts` for thread replies
  - Uses `event.ts` for new messages (becomes the thread ID)
- Creates/reuses agent with slug `slack-{thread_id}` using the `pi` harness
- Sends formatted message to the agent's tmux session

### Agent Manager (apps/daemon/server/services/agent-manager.ts)

- Uses per-harness ready wait heuristics (pi: 3s, claude-code: 5s)

## Database Schema

### projectConnection table

- `webhookTargetMachineId`: FK to `machine.id` (nullable, set null on delete)
- When set, incoming webhooks for this connection are forwarded to the machine's daemon

## Machine Types for Forwarding

| Type           | URL Format                                                                     |
| -------------- | ------------------------------------------------------------------------------ |
| `local`        | `http://{metadata.host}:{metadata.port}/api/integrations/slack/webhook`        |
| `local-docker` | `http://localhost:{metadata.port}/api/integrations/slack/webhook`              |
| `daytona`      | `https://3001-{externalId}.proxy.daytona.works/api/integrations/slack/webhook` |

## tRPC Endpoints

- `project.getSlackWebhookTargetMachine`: Get current webhook target machine for Slack
- `project.setSlackWebhookTargetMachine`: Set/update webhook target machine (pass `null` to disable)

## Testing

### E2E Tests

- `e2e/daemon-slack-webhook.e2e.ts`: Tests daemon webhook handler directly
- `e2e/slack-webhook-integration.e2e.ts`: Full integration test

Run with: `pnpm e2e e2e/daemon-slack-webhook.e2e.ts`

### Message Format

```
New Slack message from <@{user}> in {channel}: {text}
```

Example: `New Slack message from <@U12345> in C_GENERAL: Hello world`
