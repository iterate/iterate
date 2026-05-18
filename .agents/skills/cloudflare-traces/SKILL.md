---
name: cloudflare-traces
description: Query and analyze Cloudflare Workers traces through the general Cloudflare API MCP server. Use when diagnosing Workers traces, distributed tracing spans, observability events, subrequest chains, or when an agent needs Cloudflare trace data programmatically.
---

# Cloudflare Traces

Use Cloudflare's general API MCP server only:

- MCP URL: `https://mcp.cloudflare.com/mcp`
- MCP server name: `cloudflare-api` or `cloudflare`
- Do not configure a separate product-specific observability endpoint.

Docs: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/

## MCP Tools

Use the general Cloudflare MCP tools:

- `mcp__cloudflare_api__.search`
- `mcp__cloudflare_api__.execute`

`execute` requires `account_id` when the token can see multiple accounts. Pass it
as the tool argument, not in the MCP URL.

## Codemode Blocks

Use these as the `code` strings passed to `mcp__cloudflare_api__.execute`.

1. Verify trace keys:

```ts
async () => {
  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/keys`,
    body: {
      datasets: ["otel"],
      from: Date.parse("2026-05-06T15:37:00.000Z"),
      to: Date.parse("2026-05-06T15:40:00.000Z"),
      keyNeedle: { value: "trace", matchCase: false },
      limit: 50,
    },
  });
};
```

2. Fetch a trace summary with `view: "traces"`:

```ts
async () => {
  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "trace-summary",
      timeframe: {
        from: Date.parse("2026-05-06T15:37:00.000Z"),
        to: Date.parse("2026-05-06T15:40:00.000Z"),
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
            value: "250178b64271952ffb1ed1711133cf78",
          },
        ],
      },
    },
  });
};
```

3. Fetch spans with `view: "events"` and the same exact `traceId` filter.

4. Summarize span events by `source.name` and `$metadata.transactionName`.

## Working Query

See [EXAMPLES.md](EXAMPLES.md) for the exact codemode block that returned
trace `250178b64271952ffb1ed1711133cf78` from `os-preview-2` with 686 spans.

If this returns no rows:

- try filter key `$metadata.traceId` as well as `traceId`
- widen the timeframe by a few minutes
- confirm `account_id` matches the worker's account
- query `view: "events"` with `needle: { value: traceId }` as a fallback

## Report

Include trace id, service/script name, timeframe, request URL, span counts,
error spans, longest repeated chain, and whether the failure surfaced to the caller.
