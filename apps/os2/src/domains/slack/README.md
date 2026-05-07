# Slack Domain

Slack is currently a codemode tool-provider domain for Slack Web API calls under
`ctx.slack.*`.

Shared Slack stream processors stay in `packages/shared` unless OS2-specific
installation or webhook behavior is added.

Most durable Slack state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
