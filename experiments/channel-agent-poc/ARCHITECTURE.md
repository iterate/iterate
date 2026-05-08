# Channel Agent POC Architecture

This POC explores a thin dynamic app host for channel-backed agents. It is not
product code; it is a reference implementation parked under `experiments/`.

## Big Ideas

The core idea is that channel apps and the agent app communicate only through
events. Channel apps know the agent event shapes. The agent processor does not
know Slack, GitHub, Linear, or Discord.

Flow:

1. A channel app receives a first-party platform event.
2. The channel app appends that raw event unchanged to a global channel stream.
3. The same raw event is cross-posted into the relevant agent thread stream.
4. The channel app processor rewrites the raw event into `agent-input-added`.
5. The copied agent loop schedules and runs the LLM.
6. The LLM emits one fenced `js` codemode block containing program body only.
7. Codemode runs that program with the channel tool provider globals installed.
8. The tool provider calls the platform SDK/API and appends the result.

The stream should show the actual raw channel event, not a hand-written summary,
then the deterministic rewrite to `agent-input-added`, then the LLM/codemode
events.

## App Boundaries

- `apps/agents`: thin agent host, event stream UI, copied agent-loop processor,
  copied codemode processor, and dynamic provider wiring.
- `apps/slack`: Slack webhook receiver and thin Slack Web API provider.
- `apps/github`: GitHub webhook receiver and GitHub App/Octokit provider.
- `apps/linear`: Linear webhook/OAuth receiver and Linear GraphQL provider.
- `apps/discord`: Discord gateway client and Discord REST provider.

Each channel app owns:

- raw platform ingestion,
- cross-posting into the agent thread stream,
- channel-specific `agent-input-added` rewrite,
- channel tool provider defaults,
- runtime credentials stored in that app's local config table.

The agents app owns:

- generic agent loop state,
- LLM request lifecycle,
- codemode extraction and execution,
- tool provider announcement,
- the stream UI.

## Event Types

POC event types use processor-qualified names:

- `events.iterate.com/agent/input-added`
- `events.iterate.com/codemode/block-added`
- `events.iterate.com/codemode/result-added`
- `events.iterate.com/slack/webhook-received`
- `events.iterate.com/github/webhook-received`
- `events.iterate.com/linear/webhook-received`
- `events.iterate.com/discord/websocket-message-received`

Legacy streams may still contain older event names from previous debugging.
Create fresh test threads when validating current behavior.

## Streams

Raw global streams:

- `/slack/webhooks`
- `/github/webhooks`
- `/linear/webhooks`
- `/discord/websocket-messages`

Agent thread streams:

- `/agents/slack/ts-<thread-ts-with-dot-replaced-by-dash>`
- `/agents/github/pr-<owner>-<repo>-<number>`
- `/agents/linear/issue-<linear-issue-id>`
- `/agents/discord/thread-<discord-channel-id>-<root-message-id>`

Discord uses one agent stream per Discord conversation root. A top-level
mention uses that message id as the root; a reply reuses the referenced message
mapping when known. Messages inside a real Discord thread use that thread
channel id as part of the stream key.

## Deployment Shape

`nested-facets/` is one Cloudflare Worker package. The Worker stores a base
template in Cloudflare Artifacts, rebases a live project repo from that base
template, then builds each app into a dynamic app facet.

Normal code edits happen in:

```text
experiments/channel-agent-poc/nested-facets/base-template/apps/<app>/
```

Then the deploy script syncs the base template, rebases the live project, and
builds the apps.

## Known POC Tradeoffs

- Processors are copied into the experiment instead of shared from a package.
- Channel runtime credentials live in app-local config tables after install.
- Webhook verification is incomplete or intentionally loose.
- Remote streams may contain noisy historical events.
- This POC is optimized for learning and reference, not production hardening.
