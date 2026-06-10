# Cloudflare Trace Query Examples

## Exact Trace Lookup

This query returned trace `250178b64271952ffb1ed1711133cf78` from
`os-preview-2` with 686 spans. It first asks for the trace summary, then asks for
the underlying span events and counts them by span name.

```ts
mcp__cloudflare_api__.execute({
  account_id: "376ef7ed81b0573f93524de763666c15",
  code: `async () => {
    const traceId = "250178b64271952ffb1ed1711133cf78";
    const timeframe = {
      from: Date.parse("2026-05-06T15:37:00.000Z"),
      to: Date.parse("2026-05-06T15:40:00.000Z"),
    };

    const traceSummary = await cloudflare.request({
      method: "POST",
      path: \`/accounts/\${accountId}/workers/observability/telemetry/query\`,
      body: {
        queryId: "trace-summary",
        timeframe,
        view: "traces",
        limit: 20,
        parameters: {
          datasets: ["otel"],
          filters: [{ key: "traceId", operation: "eq", type: "string", value: traceId }],
        },
      },
    });

    const spanEvents = await cloudflare.request({
      method: "POST",
      path: \`/accounts/\${accountId}/workers/observability/telemetry/query\`,
      body: {
        queryId: "trace-events",
        timeframe,
        view: "events",
        limit: 2000,
        parameters: {
          datasets: ["otel"],
          filters: [{ key: "traceId", operation: "eq", type: "string", value: traceId }],
        },
      },
    });

    const events = spanEvents.result?.events?.events ?? [];
    const byName = Object.fromEntries(
      Object.entries(events.reduce((acc, event) => {
        const name = event.source?.name ?? event.$metadata?.spanName ?? "unknown";
        acc[name] = (acc[name] ?? 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1]),
    );

    return {
      traceSummary: traceSummary.result?.traces,
      eventCount: events.length,
      byName,
    };
  }`,
});
```

Expected high-signal output for this trace:

```json
{
  "eventCount": 686,
  "byName": {
    "durable_object_storage_exec": 247,
    "jsrpc": 205,
    "durable_object_subrequest": 199,
    "durable_object_storage_kv_get": 22,
    "durable_object_storage_kv_put": 8,
    "d1_batch": 3,
    "fetch": 1,
    "GET": 1
  }
}
```
