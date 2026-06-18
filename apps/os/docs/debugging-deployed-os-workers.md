# Debugging Deployed OS Workers

Assume we are debugging:

1. OS at `https://os.iterate.com`
2. project ingress under `iterate.app`
3. project slug `iterate`

Use `preview_N` or `prd` configs for deployed workers. For local dev, use
`dev` or `dev_<user>` with `pnpm dev`; scripts discover the running server from
`.alchemy/dev-server.json`. Run CLI commands from `apps/os`; plain
`pnpm cli ...` uses local Doppler setup, and
`doppler run --config <config> -- pnpm cli ...` targets a specific deployment.

## Common CLI Targets

```bash
# Local dev through the discovery file. Requires `pnpm dev` or `pnpm dev start --detach`.
pnpm cli itx --help

# Fully-local dev server with an explicit config.
doppler run --config dev -- pnpm cli itx --help

# Explicit local/captun override, if you are not using the discovery file.
doppler run --config dev -- pnpm cli --base-url http://localhost:<port> itx --help

# Production.
doppler run --config prd -- pnpm cli itx --help

# Active preview slot. Use a healthy leased preview, not a stale slot number.
doppler run --config preview_3 -- pnpm cli itx --help
```

## Project Interaction Paths

### itx CLI

Prefer this first. It is typed through the live project capability handle and
avoids hand-assembling URLs.

```bash
doppler run --config prd -- pnpm cli itx run \
  --context iterate \
  -e 'const stream = await itx.streams.get("/debugging-docs/example"); return await stream.getEvents({ beforeOffset: "end", limit: 100 })'
```

Append and read in one script:

```bash
doppler run --config prd -- pnpm cli itx run \
  --context iterate \
  -e 'const stream = await itx.streams.get("/debugging-docs/example"); const appended = await stream.append({ event: { type: "events.iterate.com/debugging-docs/example", payload: { source: "itx" } } }); const history = await stream.getEvents({ afterOffset: appended.offset - 1, beforeOffset: "end" }); return { appended, history }'
```

List projects from the global admin handle:

```bash
doppler run --config prd -- pnpm cli itx run \
  -e 'return await itx.projects.list({ limit: 20 })'
```

### Project MCP

The OS MCP transport is the app worker's `/api/mcp` Start route. Production
advertises `https://mcp.iterate.com` as the canonical OAuth resource URL, and
ingress rewrites that hostname to the same route. The app-host
`https://os.iterate.com/api/mcp` route is also valid. Fully-local dev defaults
to `<baseUrl>/api/mcp`. `/projects/:slug/mcp` is the dashboard UI, not the
transport URL. Admin-token sessions expose all projects and the `exec_js` tool
requires a project slug when it runs.

```text
https://mcp.iterate.com
```

Start Claude with that MCP server preconfigured:

```bash
cd apps/os
doppler run --config prd -- pnpm cli claude-mcp
```

For previews, run under the preview Doppler config:

```bash
doppler run --config preview_3 -- pnpm cli itx run -e 'return await itx.projects.list({ limit: 20 })'
doppler run --config preview_3 -- pnpm cli claude-mcp
```

Or leave it running in tmux:

```bash
tmux new -s os-iterate-mcp 'cd apps/os && doppler run --config prd -- pnpm cli claude-mcp'
```

## Authentication

Most operator paths use the OS admin bearer token from the deployment's Doppler
config. The `pnpm cli itx ...` commands read `APP_CONFIG_BASE_URL` and
`APP_CONFIG_ADMIN_API_SECRET` from Doppler.

Browser debugging can also authenticate through the Iterate Auth Worker.

For a preview, change the config and discover a current project first. Avoid
hard-coding disposable preview projects.

```bash
doppler run --config preview_3 -- pnpm cli itx run \
  -e 'return await itx.projects.list({ limit: 20 })'
```

## Useful itx Snippets

```bash
# Confirm the project resolves.
doppler run --config prd -- pnpm cli itx run \
  -e 'return await itx.projects.get("iterate")'

# List initialized child streams under root.
doppler run --config prd -- pnpm cli itx run \
  --context iterate \
  -e 'return await itx.streams.get("/").runtimeState()'

# Read a stream.
doppler run --config prd -- pnpm cli itx run \
  --context iterate \
  -e 'return await itx.streams.get("/debugging-docs/example").getEvents({ beforeOffset: "end", limit: 100 })'

# Inspect an agent runtime state.
doppler run --config prd -- pnpm cli itx run \
  --context iterate \
  -e 'return await itx.agents.create().getRuntimeState({ agentPath: "/agents/default" })'
```

## Cloudflare Debugging

### Cloudflare MCP Server

Use the Cloudflare API MCP server for Workers traces, routes, bindings, D1,
Durable Objects, and other Cloudflare state. Docs:
[Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/).

The deployed worker name is derived in `packages/shared/src/alchemy/init.ts` as
`${manifest.slug}-${app.stage}` and then used by `apps/os/alchemy.run.ts` as
`ctx.workerName`. For production OS, `os-prd` is the ingress router; the app
worker is `os-prd-app` and each Durable Object class has its own worker
(`os-prd-stream`, `os-prd-agent`, `os-prd-project`,
`os-prd-slack-integration`, ...). See [worker-topology.md](./worker-topology.md).
Pick the worker that owns the code you are debugging.

OS workers have persistent Workers Logs and traces enabled in
`packages/shared/src/alchemy/iterate-app.ts`.

Ray IDs are especially useful. If you have a Ray ID, first find the matching
log event, then use its `traceId` to fetch the trace and all span events.

With the general Cloudflare API MCP server, use `search` to find endpoint
shapes, then `execute` with a Workers Observability telemetry query.
