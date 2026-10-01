# Telemetry

## How it works

Four Iceberg tables in one R2 bucket per Cloudflare account — `events`, `logs`, `spans`,
`metrics` — are written by Cloudflare Pipelines and read with R2 SQL or DuckDB. The platform hook
in `core/os` sends every durable event to the `events` stream; Cloudflare's OTLP export posts
`core/os`'s logs and spans to `apps/telemetry`, which flattens them into the `logs` and `spans`
streams; `metrics.count/gauge/time` (`iterate/metrics`) write Analytics Engine data points, which
the hourly health job copies into the `metrics` stream. Every row carries `time`, `worker`,
`project_id` and `path`, and each table keeps everything else it has in one JSON column. Analytics
Engine serves live dashboards and alerts (90 days, sampled); the tables answer everything else, a
few minutes behind.

```
core/os platform hook ─────────────────────────────────────────────────▶ events stream ─┐
core/os console.* and spans ─ OTLP export ─▶ apps/telemetry ─────▶ logs, spans streams ─┼─▶ sinks ─▶ Iceberg in R2 ─▶ R2 SQL, DuckDB
core/os iterate/metrics ─▶ Analytics Engine ─▶ health job, hourly ────▶ metrics stream ─┘
                           Analytics Engine ─▶ apps/admin /telemetry, health-job alerts
```

| from the thing happening to       |                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| a queryable `events` row          | 1–2 minutes (the sink rolls every 60 s)                                                                                                       |
| a queryable `logs` or `spans` row | 2.5–4.5 minutes, the same for both: Cloudflare posts a batch a minute, about 90 s after its newest record, and the sink takes about 75 s more |
| a queryable `metrics` row         | up to 2 hours (copied once an hour closes)                                                                                                    |
| an Analytics Engine answer        | under 1 minute                                                                                                                                |

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

| column                       | type                  | from                                                                        |
| ---------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `version`                    | string                | `cloudflare.script_version.id`                                              |
| `level`                      | string                | `debug`, `info` (9), `warn` (13), `error` (17: `console.error`, exceptions) |
| `trace_id`, `span_id`, `seq` | string, string, int32 | the record's ids; `seq` orders lines within a millisecond                   |
| `event`                      | string                | the body's `event` field, when the body is an object with one               |
| `body`, `body_bytes`         | string, int32         | a string as written, an object as JSON                                      |
| `exception`, `stack`         | string                | `exception.type: exception.message`, `exception.stacktrace`                 |

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
const m = metrics(env, { projectId, path }); // env.METRICS, and env.WORKER_NAME
m.count("subscription.retries", 1, "row=config");
m.gauge("subscription.pending", pending, "row=config");
m.time("subscription.delivery_ms", ms, "row=config");
```

`WORKER_NAME` is a var every `core/os` deployment's config sets, since the runtime does not tell a
Worker its own name. Each call is one `writeDataPoint`, which never blocks and is never awaited: `index1` is the
project, so a busy project cannot crowd out a quiet one's samples, and `blob1…6` are name, kind,
worker, project, path and labels (a layout that can only grow at the end). An invocation may write
250 points; past that `writeDataPoint` throws, so the module drops the point and logs the first
drop of each isolate. Call it once per batch, never once per item. Timings come from the Workers
clock, which moves only across I/O: a delivery that crosses none reads 0 ms.

## Reading

- **Live** — the `/telemetry` page in `apps/admin` (TanStack Charts), and the health job's alert
  rules (`scripts/monitors/telemetry.ts`), query Analytics Engine's SQL API. It has no CTEs, JOINs
  or UNION: every panel and rule is one flat query. Analytics Engine bills $1.00 per million read
  queries past a million a month, whatever a query reads, and bills nothing yet; its answers say
  nothing of what a query read, so the page counts each panel's stored points in one more query and
  shows them beside the panel's price.
- **History** — R2 SQL over the four tables (`wrangler r2 sql query`, or its HTTP API), or DuckDB
  (1.4+) attached to the catalog. R2 SQL reads only the columns a query names, from the files whose
  statistics its filters cannot rule out, and answers with the bytes it scanned: $2.50 per TB, 10
  MB at least. Nothing is sorted, so a filter on an id (a trace, a project) reads that column of
  every file in range: bound such a query by `time`.

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
  nothing. A retried batch can land twice: dedupe on each table's key (`metrics` has none: see
  its copy below).
- It sends in chunks under 5 MB. A stream accepts a row that breaks its schema and drops it
  silently, so tests check every row the flattening makes against its schema, and the health job
  alerts on dropped rows.
- The platform hook sends without waiting: an event in flight when a context resets is lost,
  logged as `telemetry.send-failed`.
- The health job copies the closed hours of metrics after a watermark it keeps in its state, 24 a
  run, and moves the watermark past each hour once all of it is sent. A failed hour is sent again
  whole, so what had landed of it lands twice. With no watermark (a first run, a lost state), it
  starts at the last closed hour.
- The health job alerts on the lake's four pipelines' dropped rows and on its two destinations'
  `last_error`.

## Privacy

Rows keep payloads and log bodies: messages, email bodies, model output. Deleting a project or a
context does not reach the lake; until a purge job exists, its rows stay. The OTLP secret sits in
plain text in the destination's config and can only append rows. Setup makes it once; to rotate it,
delete it from Doppler and run setup again.

## Setting up an account

`pnpm --dir apps/telemetry ensure-resources --env <env>` creates, idempotently, from
`apps/telemetry/schemas/`: the bucket and its catalog, compaction and snapshot expiration, a
stream, sink and pipeline per table, the Worker's secret, and the two OTLP destinations. A stream's
schema cannot change and a sink cannot adopt an existing table, so a column change is a new table
(`logs_v2`) and a new stream, sink and pipeline; delete the old ones once drained (an account allows
20 of each).

## Queries

Each ran on PR 3478's preview (`pr3478-7cede58`, 2026-09-30) with `wrangler r2 sql query` or the
HTTP API, and the catalog token; what each scanned and cost was measured on 2026-10-01, once
compaction had merged each table's files into six. R2 SQL answers every query with the bytes it
scanned, and bills $2.50 per TB of them, 10 MB at least, past the 10 GB a month included. `offset`
is a reserved word: quote it, `"offset"`.

```sql
-- the event types a deployment wrote, and how big their payloads are
-- scanned 768 KB in 6 files, billed as 10 MB: $0.000025
SELECT type, count(*) AS n, approx_median(payload_bytes) AS median_bytes, max(payload_bytes)
FROM telemetry.events WHERE worker LIKE 'pr3478-%' GROUP BY type ORDER BY n DESC LIMIT 12

-- a field of the payload, by type: why contexts woke (call 1,230, alarm 27)
-- scanned 605 KB in 6 files, billed as 10 MB: $0.000025
SELECT CASE WHEN payload_bytes < 2000 THEN json_get_str(payload, 'cause') END AS cause, count(*)
FROM telemetry.events WHERE type = 'events.iterate.com/itx/woken' GROUP BY 1

-- one project's newest events (reads project_id, path, type and "offset", never payload)
-- scanned 246 KB in 6 files, billed as 10 MB: $0.000025
SELECT path, type, "offset" FROM telemetry.events
WHERE project_id = 'prj_d43815cd66c840d6b6251432f792c3b7' ORDER BY "offset" DESC LIMIT 3

-- what a deployment logged, by level and event
-- scanned 148 KB in 6 files, billed as 10 MB: $0.000025
SELECT level, event, count(*) AS n FROM telemetry.logs WHERE worker LIKE 'pr3478-%'
GROUP BY level, event ORDER BY n DESC LIMIT 10

-- latency by RPC method
-- scanned 2.6 MB in 6 files, billed as 10 MB: $0.000025
SELECT rpc_method, count(*) AS n, approx_percentile_cont(duration_ms, 0.5) AS p50,
  approx_percentile_cont(duration_ms, 0.99) AS p99
FROM telemetry.spans WHERE rpc_method IS NOT NULL GROUP BY rpc_method ORDER BY n DESC

-- a log line's context from its span, when the line did not name it
-- scanned 16.3 MB in 12 files: $0.000041
SELECT coalesce(l.project_id, s.project_id) AS project_id, l.event, count(*) AS n
FROM telemetry.logs l JOIN telemetry.spans s ON l.span_id = s.span_id
WHERE l.level = 'warn' GROUP BY 1, 2 ORDER BY n DESC

-- one trace, the Worker's spans and the Durable Object's under them
-- scanned 12.4 MB in 6 files: $0.000031
SELECT time, span_id, parent_span_id, name, entrypoint, rpc_method, path, duration_ms
FROM telemetry.spans WHERE trace_id = 'e7668882ead36f4184d0d419c6ad435f' ORDER BY time

-- a metric's weighted p99 by hour (Analytics Engine sampled it: weigh every point)
-- scanned 36 KB in 6 files, billed as 10 MB: $0.000025
SELECT date_trunc('hour', time) AS hour,
  approx_percentile_cont_with_weight(value, weight, 0.99) AS p99, sum(weight) AS deliveries
FROM telemetry.metrics WHERE name = 'subscription.delivery_ms' GROUP BY 1 ORDER BY 1
```

The last query's 14:00 hour, copied from Analytics Engine, gave a p99 of 10,887 ms over 8,014
deliveries (4,754 points); Analytics Engine itself answered 10,894 ms. Without the guard, the second
query fails as soon as it meets one large payload: `json_get_str()
argument 1 exceeds the maximum byte length of 2000 (got 2141 bytes)`. A query pays for the columns
it names: counting one project's events read 608 KB, and summing their payloads too read 1.8 MB, of
the same 18 files.
