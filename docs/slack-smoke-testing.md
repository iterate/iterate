# Slack Smoke Testing

> **Status: historical (pre-itx-v4 procedure).** The Slack integration was
> rebuilt on itx in the itx-v4 replacement (PR #1585) — Durable Object names
> and event routes below describe the pre-migration stack and no longer
> exist. For current real Slack testing, preview app setup, and internal
> duplicate-bot caveats, start with [slack-testing.md](slack-testing.md).
> Recover the old implementation from git history if ever needed.

This note describes the manual production smoke test for proving that a Slack
thread can wake a routed Slack agent and produce a real Slack reply.

## What This Tests

The smoke test covers the OS-side production path after Slack ingress:

1. A Slack thread exists in a real Slack channel.
2. OS receives a webhook-shaped `events.iterate.com/slack/webhook-received`
   event on the project's `/integrations/slack` stream.
3. `SlackIntegrationDurableObject` routes that event to
   `/agents/slack/<channel>/ts-<thread>`.
4. `SlackAgentDurableObject` transcribes the Slack event into agent input.
5. `AgentDurableObject` starts the LLM request.
6. The itx script calls `itx.slack.chat.postMessage`.
7. A real Slack reply appears in the original thread.

It does not prove Slack's Events API delivery latency unless the trigger event
is sent by a real non-OS Slack actor and arrives through
`/api/integrations/slack/webhook`. For local/manual timing, we usually append
the webhook-shaped event directly so we can isolate OS routing and agent
latency.

## Important Self-Wake Rule

The OS Slack bot must not wake itself. A message sent with the environment's
Slack fallback token is useful for creating a real Slack thread, but it should
not be treated as the inbound trigger. Current configs keep that fallback at
`APP_CONFIG_INTEGRATIONS__SLACK.botToken`; `APP_CONFIG_SLACK_BOT_TOKEN` is only
the legacy top-level fallback during migration.

To test bot-originated wakeups, use either:

- a second Slack bot/app token that is not the OS bot, or
- a webhook-shaped event whose Slack event identity is not the OS bot.

The second option is a pragmatic smoke test for OS latency. The first option is
the full end-to-end Slack ingress test.

## Prerequisites

Run commands from `apps/os`.

- `doppler` access to the target OS config.
- `APP_CONFIG_ADMIN_API_SECRET` in that config.
- `APP_CONFIG_INTEGRATIONS__SLACK.botToken` in that config, or the legacy
  `APP_CONFIG_SLACK_BOT_TOKEN` during migration.
- The OS Slack bot is a member of `#slack-agent-e2e-test`.
- The target app is deployed and reachable through `APP_CONFIG_BASE_URL`.

For production:

```bash
doppler run --project os --config prd -- sh -c 'echo "$APP_CONFIG_BASE_URL"'
```

## Manual Smoke Process

1. Resolve the Slack channel ID for `#slack-agent-e2e-test` with
   `conversations.list`.
2. Create a temporary OS project through the admin-authenticated itx CLI.
3. Post a real root message to Slack with `chat.postMessage`. This creates the
   thread the agent will reply to.
4. Subscribe the project's `/integrations/slack` stream to the production
   `SLACK_INTEGRATION` Durable Object.
5. Append a webhook-shaped `events.iterate.com/slack/webhook-received` event to
   `/integrations/slack`.
6. Use a trigger such as:

   ```text
   !slack.chat.postMessage({ channel: "C...", thread_ts: "177...", text: "..." })
   ```

7. Poll the routed Slack-agent stream until
   `events.iterate.com/itx/script-execution-completed` appears for the script
   that calls `itx.slack.chat.postMessage`.
8. Record the wall-clock duration from appending the webhook event to the
   completed itx script execution.
9. Inspect the routed stream for these useful timestamps:
   - `events.iterate.com/slack/webhook-received`
   - `events.iterate.com/agent/input-added`
   - `events.iterate.com/openai-ws/llm-request-started`
   - `events.iterate.com/itx/script-execution-completed`

10. Remove the temporary OS project.

## Timing Notes

The wall-clock duration includes polling interval overhead if measured outside
the stream. Prefer event `createdAt` deltas when comparing code changes.

For the ordering hotfix, the interesting check is whether the routed stream
shows `slack-agent:` work before the slower `agent:` subscriber processes the
raw Slack webhook. The expected effect is a faster transition from
`slack/webhook-received` to `agent/input-added` and then to LLM request start.
