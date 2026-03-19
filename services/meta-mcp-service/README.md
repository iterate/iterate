# Meta MCP Service

Minimal MCP aggregator service for runtime-discovered upstream MCP servers.

## What it does

- exposes one MCP server at `/mcp`
- lets callers discover and invoke tools from configured upstream MCP servers
- manages OAuth for upstream servers that require it
- reads server config from `servers.json`
- stores OAuth state, client registrations, and tokens in `auth.json`

## Main files

- `src/index.ts` - process entrypoint
- `src/metamcp/server.ts` - HTTP routes and MCP server wiring
- `src/metamcp/tools.ts` - built-in Meta MCP helper tools
- `src/upstream-manager.ts` - upstream server loading, probing, discovery, and tool calls
- `src/auth/auth-manager.ts` - OAuth state and token lifecycle
- `src/config/servers-file.ts` - simple `servers.json` read/update helpers

## Test surface

- Vitest unit tests for tools, OAuth manager, execution environment, and upstream manager
- Vitest integration tests for MCP transport, add-server flow, execute flow, and OAuth routes
