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
  --context <prj_id> \
  -e 'return await itx.streams.get("/debugging-docs/example").getEvents({ limit: 100 })'
```

Append and read in one script:

```bash
doppler run --config prd -- pnpm cli itx run \
  --context <prj_id> \
  -e 'const stream = itx.streams.get("/debugging-docs/example"); const [appended] = await stream.append({ type: "events.iterate.com/debugging-docs/example", payload: { source: "itx" } }); const history = await stream.getEvents({ afterOffset: appended.offset - 1 }); return { appended, history }'
```

List project ids from the global admin session:

```bash
doppler run --config prd -- pnpm cli itx run \
  --eval 'return await itx.projects.list()'
```

`--context` takes the project ID (`prj_…`).

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
doppler run --config preview_3 -- pnpm cli itx run --eval 'return await itx.projects.list()'
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
  --eval 'return await itx.projects.list()'
```

## Useful itx Snippets

```bash
# Confirm the project resolves and list its capabilities.
doppler run --config prd -- pnpm cli itx run \
  --eval 'const project = await itx.projects.get("<prj_id>"); return await project.describe()'

# List the project's streams.
doppler run --config prd -- pnpm cli itx run \
  --context <prj_id> \
  --eval 'return await itx.streams.list()'

# Read a stream.
doppler run --config prd -- pnpm cli itx run \
  --context <prj_id> \
  --eval 'return await itx.streams.get("/debugging-docs/example").getEvents({ limit: 100 })'

# Inspect an agent's processor runtime state.
doppler run --config prd -- pnpm cli itx run \
  --context <prj_id> \
  --eval 'return await itx.agents.get("/agents/default").processor.getRuntimeState()'
```

## Cloudflare Debugging

### Cloudflare MCP Server

Use the Cloudflare API MCP server for Workers traces, routes, bindings,
Durable Objects, and other Cloudflare state. Docs:
[Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/).

The deployed worker name is derived in `packages/shared/src/alchemy/init.ts` as
`${manifest.slug}-${app.stage}` and then used by `apps/os/alchemy.run.ts` as
`ctx.workerName`. For production OS, `os-prd` is the ingress router; the app
worker is `os-prd-app`, the engine API is `os-prd-api`, and each Durable
Object class has its own worker (`os-prd-stream`, `os-prd-itx`,
`os-prd-project`, `os-prd-agent`, `os-prd-repo`, `os-prd-secret`,
`os-prd-worker`). See [worker-topology.md](./worker-topology.md). Pick the
worker that owns the code you are debugging.

OS workers have persistent Workers Logs and traces enabled in
`packages/shared/src/alchemy/iterate-app.ts`.

Ray IDs are especially useful. If you have a Ray ID, first find the matching
log event, then use its `traceId` to fetch the trace and all span events.

With the general Cloudflare API MCP server, use `search` to find endpoint
shapes, then `execute` with a Workers Observability telemetry query.

For production OS request traces, use the `otel` dataset. The `workers`
dataset may expose metadata keys but can return no request rows for the app
traffic you are trying to inspect. The useful production service names are
`os-prd` for ingress and `os-prd-app` for the app worker; do not filter on
`$metadata.service == "os"`.

Start with recent `events`, then use the returned `traceId` to inspect the
whole trace. Keep the response compact by mapping the Cloudflare result before
returning it:

```ts
async () => {
  const from = Date.parse("2026-07-02T12:15:00.000Z");
  const to = Date.parse("2026-07-02T12:45:00.000Z");
  const resp = await cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "prod-os-mcp-events",
      timeframe: { from, to },
      view: "events",
      limit: 200,
      parameters: {
        datasets: ["otel"],
        filters: [
          {
            key: "$metadata.service",
            operation: "in",
            type: "string",
            value: "os-prd,os-prd-app",
          },
        ],
        needle: { value: "mcp", matchCase: false },
      },
    },
  });
  return (resp.result?.events?.events ?? []).map((event) => ({
    iso: new Date(event.timestamp).toISOString(),
    service: event.$metadata?.service,
    level: event.$metadata?.level,
    error: event.$metadata?.error,
    requestId: event.$metadata?.requestId,
    traceId: event.$metadata?.traceId,
    tx: event.$metadata?.transactionName,
    url: event.source?.url?.full,
    method: event.source?.http?.request?.method,
    status: event.source?.http?.response?.status_code,
    ua: event.source?.user_agent?.original,
    ray: event.source?.cloudflare?.ray_id,
  }));
};
```

To discover current keys or values, use `keys` and `values`. The `values`
endpoint requires `timeframe` and `type`:

```ts
async () => {
  const timeframe = {
    from: Date.parse("2026-07-02T12:15:00.000Z"),
    to: Date.parse("2026-07-02T12:45:00.000Z"),
  };
  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/values`,
    body: {
      datasets: ["otel"],
      timeframe,
      key: "$metadata.service",
      type: "string",
      limit: 100,
    },
  });
};
```

For status-code breakdowns, the current key is
`http.response.status_code`, not `$metadata.statusCode`.
