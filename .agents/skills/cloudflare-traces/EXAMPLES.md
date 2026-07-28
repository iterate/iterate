# Cloudflare Observability Query Examples

Pass each function as the `code` argument to the general Cloudflare MCP
`execute` tool. Replace the placeholders and pass the account as `account_id`.

## Correlate a call ID across logs and spans

```ts
async () => {
  const value = "log_<call-id>";
  return cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "correlate-call-id",
      timeframe: {
        from: Date.parse("<from-utc>"),
        to: Date.parse("<to-utc>"),
      },
      view: "events",
      limit: 100,
      parameters: {
        datasets: [],
        needle: { value, matchCase: true },
        filters: [
          {
            key: "$metadata.service",
            operation: "eq",
            type: "string",
            value: "<service>",
          },
        ],
      },
    },
  });
};
```

Normally the `cloudflare-workers` row supplies the bounded structured log and
the `otel` row supplies `traceId`, span IDs, and span attributes. Construct the
dashboard link from the account and trace IDs. Treat those dataset names as the
current API mapping, not a stable schema.

## Fetch and summarize an exact trace

```ts
async () => {
  const traceId = "<trace-id>";
  const response = await cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "exact-trace",
      timeframe: {
        from: Date.parse("<from-utc>"),
        to: Date.parse("<to-utc>"),
      },
      view: "events",
      limit: 2000,
      parameters: {
        datasets: ["otel"],
        filters: [{ key: "traceId", operation: "eq", type: "string", value: traceId }],
      },
    },
  });
  const events = response.result?.events?.events ?? [];
  return events.map((event) => ({
    name: event.source?.name ?? event.$metadata?.spanName,
    spanId: event.source?.spanId ?? event.$metadata?.spanId,
    parentSpanId: event.source?.parentSpanId ?? event.$metadata?.parentSpanId,
    start: event.source?.startTime ?? event.$metadata?.startTime,
    end: event.source?.endTime ?? event.$metadata?.endTime,
    durationMS: event.source?.durationMS,
    outcome: event.source?.itx?.outcome ?? event.source?.outcome,
  }));
};
```

## Fetch one structured operation log

```ts
async () =>
  cloudflare.request({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "operation-log",
      timeframe: { from: Date.parse("<from-utc>"), to: Date.parse("<to-utc>") },
      view: "events",
      limit: 20,
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [{ key: "log.id", operation: "eq", type: "string", value: "log_<id>" }],
      },
    },
  });
```

Use `log.parentId` to walk to the parent operation and `itx.sessionId` to find
other calls from the same long-running ITX WebSocket.
