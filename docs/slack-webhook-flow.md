# Slack Integration

This document describes how Slack webhooks and slash commands are received, processed, and forwarded to daemon agents.

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
    └─── 7. Send message to agent via harness
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
- Sends formatted message to the agent via the harness

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

## Slash Commands

### Architecture

```
Slack Platform
    │
    ▼
OS Backend (/api/integrations/slack/commands)
    │
    ├─── 1. Verify Slack signature
    ├─── 2. Parse URL-encoded payload
    ├─── 3. Validate with Zod schema
    ├─── 4. Find projectConnection by team_id
    │
    ▼ (if active machine found)
Machine Forward (via buildMachineForwardUrl)
    │
    ▼
Daemon (/api/integrations/slack/commands)
    │
    ├─── 5. Validate payload with Zod
    ├─── 6. Process command (e.g., /debug)
    └─── 7. Send response to Slack via response_url
```

### Supported Commands

#### `/debug`

Returns agent session information and an opencode attach URL for the current thread.

**Response includes:**

- Agent slug (e.g., `slack-1234567890-123456`)
- Session ID
- Clickable terminal URL with pre-filled `opencode attach` command

**Usage:**

- Must be run in a thread where an agent is active
- Returns ephemeral message (only visible to user who ran command)

### Configuration

To add slash commands to your Slack app:

1. **Go to [Slack API Dashboard](https://api.slack.com/apps)**

2. **Select your app** (or create one if you don't have one)

3. **Navigate to "Slash Commands"** in the left sidebar

4. **Click "Create New Command"**

5. **Configure the command:**
   - **Command:** `/debug`
   - **Request URL:** `https://your-domain/api/integrations/slack/commands`
     - For production: `https://os.iterate.com/api/integrations/slack/commands`
     - For staging: `https://dev-{env}-os.dev.iterate.com/api/integrations/slack/commands`
   - **Short Description:** Get agent session debug info
   - **Usage Hint:** (leave empty)
   - **Escape channels, users, and links sent to your app:** ✅ (checked)

6. **Click "Save"**

7. **Reinstall your app** if prompted (required for slash command changes)

### Slack App Manifest

Alternatively, you can add slash commands via the app manifest. Add this to your manifest YAML:

```yaml
features:
  slash_commands:
    - command: /debug
      url: https://os.iterate.com/api/integrations/slack/commands
      description: Get agent session debug info
      usage_hint: ""
      should_escape: true
```

### Implementation Details

**OS Backend** (`apps/os/backend/integrations/slack/slack.ts`):

- Receives slash commands from Slack
- Validates signature and payload using Zod
- Forwards to active machine daemon
- Returns immediate acknowledgment (Slack requires <3s response)

**Daemon** (`apps/daemon/server/routers/slack.ts`):

- Receives forwarded commands
- Validates payload with Zod schema
- Looks up agent by thread_ts
- Builds terminal URL with opencode attach command
- Sends response to Slack via `response_url` (supports delayed responses up to 30 minutes)
