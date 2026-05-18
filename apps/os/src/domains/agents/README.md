# Agents Domain

Agents is currently a POC codemode tool-provider domain for Durable
Object-backed subagent handles exposed as `ctx.agents.create()`.

Most durable agent state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
