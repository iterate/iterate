# Slack Domain

Slack owns OS's Slack Web API itx capability and the project-local
Slack event bridge.

The incoming flow is:

- Slack Events API webhooks are validated by `src/domains/secrets/integration-api.ts`
  and appended to the claimed project's `/integrations/slack` stream.
- `SlackIntegrationDurableObject` subscribes to that stream and runs the shared
  `slack` processor. It maintains `channel:thread_ts -> /agents/slack/<channel>/ts-...`
  routing state and forwards raw webhook events to the routed stream.
- Routed Slack streams run both `SlackAgentDurableObject` and
  `AgentDurableObject`. `slack-agent` owns Slack route context, bang commands,
  Slack status/reaction side effects, and `itx.slack.agent.threadInfo()`.
- The platform `ProjectProcessor` owns Slack-specific agent setup for
  `/agents/slack/...` streams. The Slack router only forwards route and webhook
  facts to those streams; hosted processors replay from their checkpoint and run
  idempotent side effects for replayed events.

Most durable Slack state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
