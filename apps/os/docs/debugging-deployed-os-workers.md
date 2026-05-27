# Debugging Deployed OS Workers

Assume we are debugging:

1. OS at `https://os.iterate.com`
2. project ingress under `iterate.app`
3. project slug `iterate`

The same patterns work for `preview_N` and `dev_<user>` Doppler configs by swapping the Doppler config. For CLI commands, run from `apps/os`: plain `pnpm cli ...` uses local Doppler setup, and `doppler run --config <config> -- pnpm cli ...` targets a specific deployment.

Common target modes:

```bash
# Local dev through your configured tunnel. Requires `pnpm dev` and a healthy tunnel.
pnpm cli rpc --help

# Direct local dev server. Use when the tunnel hostname is not reachable.
doppler run --config dev_jonas -- pnpm cli --base-url http://localhost:5173 rpc --help

# Localhost-specific config. Requires `pnpm dev:localhost`.
doppler run --config dev_localhost -- pnpm cli rpc --help

# Production.
doppler run --config prd -- pnpm cli rpc --help

# Active preview slot. Use a healthy leased preview, not a stale slot number.
doppler run --config preview_3 -- pnpm cli rpc --help
```

## Project Interaction Paths

### oRPC CLI

Prefer this first. It is typed, discoverable, and avoids hand-assembling URLs.
Run from `apps/os`.

```bash
doppler run --config prd -- pnpm cli rpc project streams read \
      --project-slug-or-id iterate \
      --stream-path /debugging-docs/example \
      --before-offset end
```

List available procedures:

```bash
pnpm cli rpc --help
pnpm cli rpc project --help
```

`trpc-cli` generates flags from each input object property. For these project
procedures, pass flags such as `--project-slug-or-id` and `--stream-path`; a
whole JSON object via `--input` is not accepted for the flattened inputs. JSON is
still useful for option values whose schema is an object or array.

### cURL

Use `curl` when you want the exact HTTP request for the same operation:

```bash
doppler run --config prd -- \
  sh -c 'curl -fsS \
    -H "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET" \
    "$APP_CONFIG_BASE_URL/api/projects/iterate/streams/events/debugging-docs/example?beforeOffset=end"'
```

### Code Mode Through oRPC

Code Mode can call project tools directly. `execute-script` returns the script request event immediately; inspect the target stream or Code Mode session stream to verify the script's later side effects.

```bash
doppler run --config prd -- pnpm cli rpc project codemode execute-script \
      --project-slug-or-id iterate \
      --code "async (ctx) => {
        const streamPath = \"/debugging-docs/example\";
        const appended = await ctx.streams.append({
          streamPath,
          event: {
            type: \"events.iterate.com/debugging-docs/example\",
            payload: { source: \"codemode\" },
          },
        });
        const history = await ctx.streams.read({
          streamPath,
          afterOffset: appended.offset - 1,
        });
        return { appended, history };
      }"
```

Then verify the append:

```bash
doppler run --config prd -- pnpm cli rpc project streams read \
      --project-slug-or-id iterate \
      --stream-path /debugging-docs/example \
      --before-offset end
```

### Project MCP

The OS MCP resource is served by the OS app at `/mcp`; select a project with
the CLI's `--project-slug-or-id` flag.

```txt
https://os.iterate.com/mcp
```

Start Claude with that MCP server preconfigured:

```bash
cd apps/os
doppler run --config prd -- pnpm cli claude-mcp --project-slug-or-id iterate
```

For previews, run under the preview Doppler config.

```bash
doppler run --config preview_3 -- pnpm cli rpc projects list
doppler run --config preview_3 -- \
  pnpm cli claude-mcp --project-slug-or-id <existing-preview-project-slug>
```

Or leave it running in tmux:

```bash
tmux new -s os-iterate-mcp 'cd apps/os && doppler run --config prd -- pnpm cli claude-mcp --project-slug-or-id iterate'
```

## Authentication

Most operator paths use the OS admin bearer token from the deployment's Doppler config:

```bash
doppler run --config prd -- \
  sh -c 'curl -fsS \
    -H "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET" \
    "$APP_CONFIG_BASE_URL/api/project/iterate"'
```

Browser debugging can also authenticate through the Iterate Auth Worker.

For `pnpm cli rpc`, prefer the CLI from `apps/os`:

```bash
pnpm cli rpc --help
doppler run --config prd -- pnpm cli rpc --help
```

For a preview, change the config and discover a current project first. Avoid hard-coding disposable preview projects.

```bash
doppler run --config preview_3 -- pnpm cli rpc projects list
doppler run --config preview_3 -- \
  pnpm cli rpc project get --project-slug-or-id <existing-preview-project-slug>
```

## Most Useful OS APIs

These are usually the first project APIs to try:

```bash
# Confirm the project resolves.
doppler run --config prd -- pnpm cli rpc project get --project-slug-or-id iterate

# List initialized streams.
doppler run --config prd -- pnpm cli rpc project streams list --project-slug-or-id iterate

# Read a stream.
doppler run --config prd -- pnpm cli rpc project streams read \
      --project-slug-or-id iterate \
      --stream-path /debugging-docs/example \
      --before-offset end

# Inspect Code Mode sessions.
doppler run --config prd -- pnpm cli rpc project codemode list-sessions --project-slug-or-id iterate

# Inspect inbound MCP sessions for the project.
doppler run --config prd -- pnpm cli rpc project inbound-mcp-server list-sessions --project-slug-or-id iterate
```

## Cloudflare Debugging

### Cloudflare MCP Server

Use the Cloudflare API MCP server for Workers traces, routes, bindings, D1, Durable Objects, and other Cloudflare state. Docs: [Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/).

The deployed worker name is derived in `packages/shared/src/alchemy/init.ts` as `${manifest.slug}-${app.stage}` and then used by `apps/os/alchemy.run.ts` as `ctx.workerName`. For production OS, that is `os-prd`.

OS workers have persistent Workers Logs and traces enabled in `packages/shared/src/alchemy/iterate-app.ts`.

Ray IDs are especially useful. If you have a Ray ID, first find the matching log event, then use its `traceId` to fetch the trace and all span events.

With the general Cloudflare API MCP server, use `search` to find endpoint shapes, then `execute` with code like:

```ts
async () => {
  const from = Date.parse("2026-05-19T13:55:00.000Z");
  const to = Date.parse("2026-05-19T14:10:00.000Z");
  const rayId = "REPLACE_WITH_RAY_ID";

  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "find-ray-id",
      timeframe: { from, to },
      view: "events",
      limit: 20,
      parameters: {
        datasets: ["logs", "otel"],
        needle: { value: rayId, matchCase: false },
      },
    },
  });
};
```

Then fetch the trace summary:

```ts
async () => {
  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "trace-summary",
      timeframe: {
        from: Date.parse("2026-05-19T13:55:00.000Z"),
        to: Date.parse("2026-05-19T14:10:00.000Z"),
      },
      view: "traces",
      limit: 20,
      parameters: {
        datasets: ["otel"],
        filters: [
          {
            key: "traceId",
            operation: "eq",
            type: "string",
            value: "REPLACE_WITH_TRACE_ID",
          },
        ],
      },
    },
  });
};
```

Fetch all spans with the same filter and `view: "events"`:

```ts
async () => {
  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "trace-spans",
      timeframe: {
        from: Date.parse("2026-05-19T13:55:00.000Z"),
        to: Date.parse("2026-05-19T14:10:00.000Z"),
      },
      view: "events",
      limit: 1000,
      parameters: {
        datasets: ["otel"],
        filters: [
          {
            key: "traceId",
            operation: "eq",
            type: "string",
            value: "REPLACE_WITH_TRACE_ID",
          },
        ],
      },
    },
  });
};
```

For broader log searches, use full text first, then add field filters:

```ts
async () => {
  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "search-os-logs",
      timeframe: {
        from: Date.now() - 15 * 60 * 1000,
        to: Date.now(),
      },
      view: "events",
      limit: 100,
      parameters: {
        datasets: ["logs"],
        needle: { value: "Project iterate not found", matchCase: false },
        filters: [
          {
            key: "$metadata.service",
            operation: "eq",
            type: "string",
            value: "os-prd",
          },
        ],
      },
    },
  });
};
```

Useful dashboard search queries:

```txt
REPLACE_WITH_RAY_ID
"Project iterate not found"
$metadata.service = "os-prd" AND $workers.outcome = "exception"
$metadata.service = "os-prd" AND $workers.wallTimeMs > 1000
exists($metadata.error)
```

### cf CLI

Use `cf` for resource and infrastructure checks when MCP access is not enough. If it is not installed or authenticated, fix that first rather than guessing from code.

### wrangler CLI

Use `wrangler` for Worker-specific operations, for example:

```bash
# Live logs, optionally filtered.
doppler run --config prd -- wrangler tail os-prd
doppler run --config prd -- wrangler tail os-prd --status error
doppler run --config prd -- wrangler tail os-prd --search "REPLACE_WITH_RAY_ID" --format json

# Deployment/version checks.
doppler run --config prd -- wrangler deployments list --name os-prd
doppler run --config prd -- wrangler versions list --name os-prd

# D1 spot checks.
doppler run --config prd -- \
  wrangler d1 execute os-prd-db --remote \
    --command "select id, slug, created_at from projects where slug = 'iterate';"
```

Resource names usually follow `ctx.workerName`; examples include `os-prd-db` and `os-prd-repos`.
