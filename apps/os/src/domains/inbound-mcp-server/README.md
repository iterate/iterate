# Inbound MCP Server Domain

Inbound MCP Server owns OS's project-scoped MCP server surface, including MCP
requests that can run code against a real project through the project's itx
context.

This is distinct from outbound MCP clients that OS can expose as itx
capabilities.

Inbound MCP is stateless at the transport layer. Durable project state belongs
to the existing project, stream, and itx domains; D1 is for queryable
projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
