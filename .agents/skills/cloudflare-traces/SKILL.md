---
name: cloudflare-traces
description: Query and audit Cloudflare Workers traces and logs through the general Cloudflare API MCP server. Use when diagnosing distributed traces, custom spans, Durable Object or Workers RPC chains, console logs, or correlation IDs.
---

# Cloudflare Traces

Use Cloudflare's general API MCP server (`https://mcp.cloudflare.com/mcp`), not
a product-specific observability endpoint.

## Current API mapping

- `otel` normally returns trace summaries and spans, including custom spans.
- `cloudflare-workers` normally returns invocation and structured `console` logs.
- `[]` searches all current datasets; use it to correlate a shared ID.

These are observed Workers Observability API dataset names, not a permanent
public schema. An `otel`-only query cannot prove a log is missing. Query the
keys/values endpoints when a dataset, field, or value is uncertain.

## Workflow

1. Use the MCP OpenAPI search tool to verify the Workers Observability
   `telemetry/query`, `keys`, and `values` endpoints.
2. Select the account explicitly when more than one is available.
3. Start with the narrowest known UTC timeframe and service name.
4. Search all datasets for a known call/log/session/request ID.
5. Follow a returned `traceId` in `otel`; follow `log.id` or `log.parentId` in
   `cloudflare-workers`.
6. Widen the timeframe before adding complicated filters.
7. Return compact fields and aggregates rather than thousands of raw events.

See [EXAMPLES.md](EXAMPLES.md) for reusable query blocks.

## Trace audit

For every semantic span report:

- `name`, `traceId`, `spanId`, `parentSpanId`;
- start, end, and duration;
- outcome/error attributes;
- script service/version; and
- whether the parent exists and how their time ranges overlap.

[OpenTelemetry permits a child to outlive its parent](https://opentelemetry.io/docs/specs/otel/trace/api/).
Judge timing against the application span's declared scope and code ordering:
flag a mismatch only when that contract says the parent must contain the child.
Treat automatic native spans separately. [Cloudflare documents beta tracing
limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/),
including 0ms non-I/O spans and incomplete attributes. Iterate also observed
native offsets that violated known code ordering on 2026-07-13; treat that as a
dated product observation and corroborate it with application attributes and a
controlled reproduction.

Observed on 2026-07-13: a failed custom ITX span's presentation message ended
in `OK` while `source.itx.outcome` was `error`. Treat message suffixes and level
as presentation metadata. Use explicit application outcome attributes; for ITX,
a correlated error-level log is useful corroboration.

## Dashboard link

Once the account and trace are known:

`https://dash.cloudflare.com/<account-id>/observability/traces/<trace-id>`

## Report

Include the account/service, UTC timeframe, trace deep link, script version,
span/log counts, semantic chain, correlation IDs, failures, span-contract
violations, and the exact query that established each conclusion.
