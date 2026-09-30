# Telemetry

## How it works

Four Iceberg tables in one R2 bucket per Cloudflare account — `events`, `logs`, `spans`,
`metrics` — are written by Cloudflare Pipelines and read with R2 SQL or DuckDB. The platform hook
in `apps/os` sends every durable event to the `events` stream; Cloudflare's OTLP export posts every
Worker's logs and spans to `apps/telemetry`, which flattens them into the `logs` and `spans`
streams; `metrics.count/gauge/time` (`iterate/metrics`) write Analytics Engine data points, which
the hourly health job copies into the `metrics` stream. Every row carries `time`, `worker`,
`project_id` and `path`, and each table keeps everything else it has in one JSON column. Analytics
Engine serves live dashboards and alerts (90 days, sampled); the tables answer everything else, a
few minutes behind.

```
apps/os platform hook ──────────────────────────────────────────▶ events stream ─┐
every Worker ─ console.* + spans ─ Cloudflare OTLP export ─▶ apps/telemetry ─▶ logs, spans streams ─┼▶ sinks ▶ Iceberg (R2) ▶ R2 SQL / DuckDB
every Worker ─ iterate/metrics ─▶ Analytics Engine ─▶ health job (hourly) ─▶ metrics stream ─────────┘
                                  Analytics Engine ─▶ apps/admin dashboard, health-job alerts
```

| from the thing happening to       |                                                          |
| --------------------------------- | -------------------------------------------------------- |
| a queryable `events` row          | 1–2 minutes (the sink rolls every 60 s)                  |
| a queryable `logs` or `spans` row | 3–5 minutes (Cloudflare posts OTLP about 2 minutes late) |
| a queryable `metrics` row         | up to 2 hours (copied once an hour closes)               |
| an Analytics Engine answer        | under 1 minute                                           |

Out of scope: code a context loads through the Worker Loader exports no logs or spans (measured);
its telemetry needs the loader's `tails`, a later step. Offloading a context's old events to R2
is out of scope.

## Tables

All four live in the namespace `telemetry`. Every row carries:

| column               | type      |                                                                                                      |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `time`               | timestamp | when it happened                                                                                     |
| `worker`             | string    | the Worker that produced it: `os-prd`, `pr3142-a1b2c3d-os`; a PR's rows are `worker LIKE 'pr3142-%'` |
| `project_id`, `path` | string    | the context it belongs to; null when none does                                                       |

Each table keeps the rest of what it has in one JSON column — `payload`, `body` or `attributes` —
with its size in `<column>_bytes`. R2 SQL's JSON functions refuse strings of 2,000 bytes or more,
so every JSON function is guarded, which R2 SQL evaluates lazily (measured over 8 MB payloads):

```sql
SELECT CASE WHEN payload_bytes < 2000 THEN json_get_str(payload, 'model') END AS model, count(*)
FROM telemetry.events GROUP BY 1
```

A value over 512 KB is cut there, because a row over 1 MB fails its whole batch. Nothing is
specific to one event type.

### events

One row per durable event of a project context. Key: `(project_id, path, offset)`.

| column                                       | type                  | from                                      |
| -------------------------------------------- | --------------------- | ----------------------------------------- |
| `offset`, `type`                             | int64, string         | the event                                 |
| `actor`                                      | string                | `source.principal.actor` (never an email) |
| `cause_chain`, `cause_depth`, `cause_parent` | string, int32, string | `source.cause`                            |
| `payload`, `payload_bytes`                   | string, int32         | the payload as JSON                       |

### logs

One row per `console.*` line or uncaught exception of every exporting Worker. Cloudflare's own
per-request log records are dropped: each repeats its root span, and carries the query string.
Key: `(span_id, seq)`.

| column                       | type                  | from                                                          |
| ---------------------------- | --------------------- | ------------------------------------------------------------- |
| `version`                    | string                | `cloudflare.script_version.id`                                |
| `level`                      | string                | `debug`, `info` (9), `warn` (13), `error` (17 and exceptions) |
| `trace_id`, `span_id`, `seq` | string, string, int32 | the record's ids; `seq` orders lines within a millisecond     |
| `event`                      | string                | the body's `event` field, when the body is an object with one |
| `body`, `body_bytes`         | string, int32         | a string as written, an object as JSON                        |
| `exception`, `stack`         | string                | `exception.type: exception.message`, `exception.stacktrace`   |

`project_id` and `path` come from the body when it has them; a line without them takes them from
its span, joined on `span_id`.

### spans

One row per span Cloudflare traces: handler invocations, fetches, Durable Object and RPC calls,
storage operations. Key: `span_id`.

| column                                         | type                          | from                                                                                                |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `version`                                      | string                        | `cloudflare.script_version.id`                                                                      |
| `trace_id`, `span_id`, `parent_span_id`, `seq` | string, string, string, int32 | W3C ids; a Durable Object's spans parent under their caller's                                       |
| `name`, `kind`                                 | string                        | `GET`, `fetch`, `jsRpcCall`, `jsrpc`, `durable_object_storage_get`, …                               |
| `duration_ms`, `cpu_ms`, `wall_ms`             | double                        | the span, `cpu_time_ms`, `wall_time_ms`                                                             |
| `outcome`                                      | string                        | `cloudflare.outcome`: `ok`, `exception`                                                             |
| `entrypoint`, `object_id`, `rpc_method`        | string                        | a Durable Object's class and id, `jsrpc.method`                                                     |
| `http_status`, `url_path`                      | int32, string                 | never the query string                                                                              |
| `exception`                                    | string                        | the span's exception event                                                                          |
| `attributes`, `attributes_bytes`               | string, int32                 | the rest, minus what every span repeats, geography, user agent, headers, `url.full` and `url.query` |

A context's entry points set `iterate.project_id` and `iterate.path` on their active span; those
become `project_id` and `path`.

### metrics

One row per Analytics Engine data point, copied as Analytics Engine stored it. It has no key:
Analytics Engine keeps time to the second, so two points can match in every column.

| column                   | type   | from                                                                  |
| ------------------------ | ------ | --------------------------------------------------------------------- |
| `name`, `kind`, `labels` | string | `subscription.delivery_ms`, `timing`, `row=config`                    |
| `value`, `weight`        | double | the point, and `_sample_interval`: how many real points it stands for |

Analytics Engine samples even at low volume, so counts and sums are weighted —
`sum(weight)`, `sum(weight * value)` — and percentiles are weighted too:
`approx_percentile_cont_with_weight(value, weight, 0.99)`. For a gauge such as queue depth, alert
on its `max`, and read its latest value per path with the newest `time`.

## Metrics

```ts
import { metrics } from "iterate/metrics";
const m = metrics(env.METRICS, { worker, projectId, path });
m.count("subscription.retries", 1, "row=config");
m.gauge("subscription.pending", pending, "row=config");
m.time("subscription.delivery_ms", ms, "row=config");
```

Each call is one `writeDataPoint`, which never blocks and is never awaited: `index1` is the
project, so a busy project cannot crowd out a quiet one's samples, and `blob1…6` are name, kind,
worker, project, path and labels (a layout that can only grow at the end). An invocation may write
250 points; past that `writeDataPoint` throws, so the module drops the point and logs once per
invocation. Call it once per batch, never once per item.

## Reading

- **Live** — the `/telemetry` page in `apps/admin`, and the health job's alert rules
  (`scripts/monitors/health.ts`), query Analytics Engine's SQL API. It has no CTEs, JOINs or
  UNION: every panel and rule is one flat query.
- **History** — R2 SQL over the four tables (`wrangler r2 sql query`, or its HTTP API), or DuckDB
  (1.4+) attached to the catalog. R2 SQL reads only the columns a query names: one project's week of
  logs reads that week's `project_id` column, a few MB.

## Settings

| setting                            | value                                                              | why                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| sink roll interval                 | 60 s                                                               | the minimum for Iceberg sinks                                                                                                                       |
| sink compression, row-group target | zstd, 32 MB                                                        | the 1 GB default made scans read whole files                                                                                                        |
| partitioning                       | `day(__ingest_ts)`, the sink's own                                 | no sort order exists; filters on `time` prune by file statistics                                                                                    |
| compaction                         | on, 128 MB target                                                  | a day's ~1,440 files per table merge into a handful                                                                                                 |
| snapshot expiration                | older than 1 day, keep 5                                           | replaced files are deleted a day after compaction                                                                                                   |
| OTLP export                        | 100 %, traces and logs, to `telemetry-traces` and `telemetry-logs` | `apps/telemetry` itself exports nothing: it would export itself                                                                                     |
| traces persisted in Cloudflare     | off, once `spans` is proven                                        | billed from 2026-10-01 at $0.60 per million past 20 M a month; logs stay persisted, since `prd-fault-alarm` and `debug-os-worker` read Workers Logs |
| retention                          | everything is kept                                                 | no purge job exists yet; the dev account's lake should keep 30 days once one does                                                                   |

## Failures

- `apps/telemetry` answers 5xx when a send fails, so Cloudflare retries the batch (it did through a
  12-minute outage); it answers 503, not 401, to a wrong secret, so rotating the secret loses
  nothing. A retried batch can land twice: dedupe on each table's key (`metrics` has none, and
  its hours are copied once).
- It sends in chunks under 5 MB and validates every row against its stream's schema first: a
  stream accepts a mismatched row and drops it silently.
- The platform hook sends without waiting: an event in flight when a context resets is lost,
  logged as `telemetry.send-failed`.
- The health job copies each closed hour of metrics once, skipping hours the lake already has, and
  backfills any gap younger than Analytics Engine's 90 days.
- The health job alerts on Pipelines' dropped-row metric and on each destination's `last_error`.

## Privacy

Rows keep payloads and log bodies: messages, email bodies, model output. Deleting a project or a
context does not reach the lake; until a purge job exists, its rows stay. The OTLP secret sits in
plain text in the destination's config and can only append rows; setup rotates it on every run.

## Setting up an account

`pnpm --dir apps/telemetry ensure-resources --env <env>` creates, idempotently, from
`apps/telemetry/schemas/`: the bucket and its catalog, compaction and snapshot expiration, a
stream, sink and pipeline per table, the Worker's secret, and the two OTLP destinations. A stream's
schema cannot change and a sink cannot adopt an existing table, so a column change is a new table
(`logs_v2`) and a new stream, sink and pipeline; delete the old ones once drained (an account allows
20 of each).

## Queries

<!-- TODO: proven R2 SQL queries from the preview -->
