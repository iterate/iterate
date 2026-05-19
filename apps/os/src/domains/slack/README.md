# Slack Domain

Slack owns OS's Slack Web API codemode tool provider and the project-local
Slack event bridge.

The incoming flow is:

- Slack Events API webhooks are validated by `src/domains/secrets/integration-api.ts`
  and appended to the claimed project's `/integrations/slack` stream.
- `SlackIntegrationDurableObject` subscribes to that stream and runs the shared
  `slack` processor. It maintains `channel:thread_ts -> /agents/slack/<channel>/ts-...`
  routing state and forwards raw webhook events to the routed stream.
- Routed Slack streams run both `SlackAgentDurableObject` and
  `AgentDurableObject`. `slack-agent` owns Slack route context, bang commands,
  Slack status/reaction side effects, and `ctx.slack.agent.threadInfo()`.
- The agent's codemode session already registers `ctx.slack.*`; Slack-specific
  setup prompts tell the model to reply with
  `ctx.slack.chat.postMessage({ channel, thread_ts, text })`.

Most durable Slack state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
