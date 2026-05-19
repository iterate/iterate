---
name: debug-mcp-server
description: Debug MCP servers with the official MCP Inspector UI and CLI. Use when an MCP server will not connect, auth fails, tools/resources/prompts are missing, or a tool call needs to be reproduced outside Codex/Claude.
---

# Debug MCP Server

Use the official MCP Inspector first. It supports stdio, SSE, and Streamable HTTP,
and has both a browser UI and a scriptable `--cli` mode.

Docs:

- https://modelcontextprotocol.io/docs/tools/inspector
- https://github.com/modelcontextprotocol/inspector

## CLI Smoke Tests

List tools on a local stdio server:

```bash
npx -y @modelcontextprotocol/inspector --cli node build/index.js --method tools/list
```

List tools on a remote Streamable HTTP server:

```bash
npx -y @modelcontextprotocol/inspector --cli https://example.com/mcp \
  --transport http \
  --method tools/list
```

Pass headers without committing secrets:

```bash
doppler run --project os --config preview_2 -- sh -lc '
  npx -y @modelcontextprotocol/inspector --cli https://mcp.cloudflare.com/mcp \
    --transport http \
    --method tools/list \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
'
```

Call a tool:

```bash
npx -y @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call \
  --tool-name mytool \
  --tool-arg key=value \
  --tool-arg 'options={"format":"json"}'
```

## UI Workflow

Run:

```bash
npx -y @modelcontextprotocol/inspector
```

Open the printed localhost URL with its proxy token. Do not disable proxy auth.
Use the UI to inspect initialization, auth, tools/resources/prompts, schemas,
request history, errors, and notifications.

## Diagnosis Loop

1. Prove transport: `tools/list` before calling a tool.
2. Prove auth separately: repeat without auth, then with the exact header.
3. Capture the raw Inspector output and exit code.
4. If `tools/list` works but a tool fails, call the smallest failing tool input.
5. Compare Inspector behavior with Codex/Claude config only after the server itself works.

## Cloudflare General MCP

Use the general Cloudflare API MCP server at `https://mcp.cloudflare.com/mcp`.
Avoid configuring a separate product-specific observability endpoint.

Cloudflare's `execute` tool accepts `account_id` as a tool argument. Do not append
it to the MCP URL. If a bearer token is rejected before initialization because it
has access to multiple accounts, use normal MCP OAuth login or a narrower token.
