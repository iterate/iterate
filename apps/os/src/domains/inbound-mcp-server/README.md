# Inbound MCP Server Domain

Inbound MCP Server owns OS's project-scoped MCP server surface, including MCP
connections that can run code against a real project.

This is distinct from outbound MCP clients that OS can expose as itx
capabilities.

Most durable inbound MCP state should stay in Durable Objects where practical.
D1 is for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
