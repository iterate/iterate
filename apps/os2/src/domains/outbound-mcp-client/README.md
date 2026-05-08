# Outbound MCP Client Domain

Outbound MCP Client owns the capability that lets codemode connect from OS2 out
to another MCP server, exposed in examples as `ctx.mcp.<serverName>`.

Most durable outbound MCP state should stay in Durable Objects where practical.
D1 is for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
