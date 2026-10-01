# Telemetry

## How it works

Four Iceberg tables in one R2 bucket per Cloudflare account — `events`, `logs`, `spans`,
`metrics` — are written by Basin Pipelines and read with Basin SQL or DuckDB. The platform hook
in `core/os` sends every durable event to the `events` stream; Cloudflare's OTLP export posts
`core/os`'s logs and spans to `apps/telemetry`, which flattens them into the `logs` and `spans`
streams; `metrics.count/gauge/time` (`iterate/metrics`) write Analytics Engine data points, which
the hourly health job copies into the `metrics` stream. Every row carries `time`, `worker`,
`project_id` and `path`, and each table keeps everything else it has in one JSON column. Analytics
Engine serves live dashboards and alerts (90 days, sampled); the tables answer everything else, a
few minutes behind.

```
core/os platform hook ─────────────────────────────────────────────────▶ events stream ─┐
core/os console.* and spans ─ OTLP export ─▶ apps/telemetry ─────▶ logs, spans streams ─┼─▶ sinks ─▶ Iceberg in R2 ─▶ Basin SQL, DuckDB
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
with its size in `<column>_bytes`. Basin SQL's JSON functions refuse strings of 2,000 bytes or more,
so every JSON function is guarded, which Basin SQL evaluates lazily (measured over 8 MB payloads):

```sql
SELECT CASE WHEN payload_bytes < 2000 THEN json_get_str(payload, 'model') END AS model, count(*)
FROM telemetry.events GROUP BY 1
```

A row over 1 MB fails its whole batch, so a JSON column is cut to fit 512 KB as the row's JSON
carries it, escaped (a value full of quotes is twice its size there), and `<column>_bytes` stays
the whole value's size. A row some other field still takes over 1 MB is not sent. Nothing is
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

One row per log record of every exporting Worker: a `console.*` line, an uncaught exception, and
Cloudflare's own record of each invocation (a fetch, an RPC call, an alarm). Key:
`(span_id, seq)`.

| column                       | type                  | from                                                                                                             |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `version`                    | string                | `cloudflare.script_version.id`                                                                                   |
| `level`                      | string                | `debug`, `info` (9), `warn` (13), `error` (17: `console.error`, exceptions)                                      |
| `trace_id`, `span_id`, `seq` | string, string, int32 | the record's ids; `seq` orders lines within a millisecond                                                        |
| `event`                      | string                | the body's `event` field, when the body is an object with one; `invocation` for Cloudflare's own record          |
| `body`, `body_bytes`         | string, int32         | a string as written, an object as JSON; an invocation's message (`GET https://…`) and every attribute it carries |
| `exception`, `stack`         | string                | `exception.type: exception.message`, `exception.stacktrace`, each cut to fit 16 KB                               |

`project_id` and `path` come from the body when it has them; a line without them takes them from
its span, joined on `span_id`. An invocation row names no project: Cloudflare writes it, and our
code cannot add to it. Its span is the invocation's root, which carries no project either. A
Durable Object's invocation carries the object's id (`cloudflare.durable_object.id`), which
`spans.object_id` ties to a project and path; the Worker's own carries only the URL, and finds a
project through its trace when the request reached a context. An invocation row is about 1 KB, so its fields answer to the guarded
JSON functions: `json_get_int(body, 'http.response.status_code')`, `json_get_str(body, 'url.path')`.

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
`approx_percentile_cont_with_weight(value, weight, 0.99)`. For a gauge, alert on its `max`, and
read its latest value per path with the newest `time`.

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

What a context's delivery loop writes today (`core/os/src/stream/subscription-delivery.ts`), each
labelled `row=<subscription>`:

| metric                     |                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription.pending`     | after each alarm pass: the offsets a row is behind the head, plus a fan-out row's deliveries not yet answered. An upper bound on what it owes: ephemeral events take offsets too, and a row's filter passes some events over                                              |
| `subscription.delivery_ms` | from an event's commit to its subscriber's answer: the oldest event of each batch of an ordered row; the longest of each burst of a fan-out row, or of each hundred events of a burst that does not end. History a row replays from before it was configured is not timed |
| `subscription.retries`     | a delivery put back on its ladder                                                                                                                                                                                                                                         |

## Reading

- **Live** — the `/telemetry` page in `apps/admin` (TanStack Charts), and the health job's alert
  rules (`scripts/monitors/telemetry.ts`), query Analytics Engine's SQL API. It has no CTEs, JOINs
  or UNION: every panel and rule is one flat query. Analytics Engine bills $1.00 per million read
  queries past a million a month, whatever a query reads, and bills nothing yet; its answers say
  nothing of what a query read, so the page counts each panel's stored points in one more query and
  shows them beside the panel's price.
- **In Cloudflare's dashboard** — nothing here feeds it. Its Custom Dashboards chart Cloudflare's own
  datasets, and the Observability page's Query Builder charts Workers Logs live, our own log
  fields included ("What Cloudflare already keeps", below); for Analytics Engine, Cloudflare names
  Grafana.
- **History** — Basin SQL over the four tables, or DuckDB (1.4+) attached to the catalog:
  `WRANGLER_BASIN_SQL_AUTH_TOKEN=<the catalog token> wrangler basin sql query <account id>_iterate-telemetry "<sql>"`,
  or its HTTP API. Basin SQL reads only the columns a query names, from the files whose
  statistics its filters cannot rule out, and answers with the bytes it scanned: $2.50 per TB, 10
  MB at least. Nothing is sorted, so a filter on an id (a trace, a project) reads that column of
  every file in range: bound such a query by `time`.

## What Cloudflare already keeps

The lake holds what only we have and what needs SQL across it: our events, our logs and spans, our
metrics. Cloudflare measures the rest itself, for every account, and none of it is copied here: it
is kept for us already, it is what Cloudflare's own dashboards chart, and it knows a Worker, a
bucket or an object's id, never a project or a path, so beside our rows it would join to nothing.
Read it where it is, with the Cloudflare MCP's `cloudflare.request` or the same call by hand.

| source                  | holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | kept                | read with                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Analytics API (GraphQL) | 243 datasets an account, 60 a zone. For what `core/os` runs on: Workers (requests, errors, CPU and wall time, memory, subrequests), Durable Objects (each object's active time, WebSockets and memory a minute; invocations; stored bytes), Pipelines (rows in, delivered, dropped), R2 (operations, bytes, catalog maintenance, Basin SQL queries), D1, KV, AI Gateway (requests, errors, spend), Workers AI, Browser Rendering, email sending, Artifacts, Logpush health | 90 days, 32 a query | `POST /graphql`; `{ __type(name: "account") { fields { name } } }` lists the datasets                                        |
| Workers Logs            | every log line and invocation of every Worker, any field of them counted, summed or ranked by percentile: the dashboard's Query Builder                                                                                                                                                                                                                                                                                                                                    | 7 days              | `POST /accounts/{id}/workers/observability/telemetry/query`                                                                  |
| Analytics Engine        | `iterate_metrics`, before the hourly copy                                                                                                                                                                                                                                                                                                                                                                                                                                  | 90 days             | `POST /accounts/{id}/analytics_engine/sql` with a token by hand: its answer is not the API's envelope, which the MCP refuses |

Live Durable Objects are the Analytics API's: `durableObjectsPeriodicGroups` by `datetimeMinute`.
Its `sum.activeTime`, in microseconds, divided by a minute's 60 million is how many objects ran at
once on average, and its `max.activeWebsocketConnections` the sockets open. The one number worth
copying some day is that active time by object: `spans.object_id` ties an object to its project,
which makes it a project's cost.

## Basin

Cloudflare's name, since 2026-10-01, for what the lake is built on: Pipelines, R2 Data Catalog and
R2 SQL are Basin Pipelines, Basin Catalog and Basin SQL. The lake uses Basin's names wherever it
has them: the catalog's API (`/basin-catalog`), the sink type `basin_catalog`, `wrangler basin`
(wrangler 4.146), Basin SQL's HTTP path (`/basin-sql/query/<bucket>`). What Cloudflare has not
renamed keeps its name: Pipelines' API (`/pipelines/v1`), the `pipelines` key of a Worker's config
and the `cloudflare:pipelines` module, the analytics datasets (`pipelines…`), a token's permission
groups. The dev account's four sinks were made the day before as `r2_data_catalog`, which a sink
keeps: the same sink, under its older name.

- **Why a Worker still receives the export.** Basin Pipelines takes four Logpush datasets, none of
  them OpenTelemetry. The one that is Workers', `workers_trace_events`, has no spans, no trace or
  span id on a log line, and 16 KB of logs an invocation. Cloudflare's roadmap names "zero-
  configuration connections across Cloudflare's developer and observability products": when Workers
  logs and traces reach a pipeline by themselves, `apps/telemetry`'s Worker goes.
- **What a pipeline's SQL could not take over.** Flattening needs a row cut to a byte budget and
  OTLP's attribute lists turned into columns; the SQL unnests one array a `SELECT`, cuts by
  characters, and cannot be changed once made.
- **Typed bindings.** `wrangler types` types a binding's rows from its stream's schema, at compile
  time only: a row that breaks the schema is still accepted and dropped. The tests check every row
  against its schema, which also holds a type to its range.
- **Coming, and worth a change when it does.** A semi-structured column type (Iceberg V3's
  Variant) in place of JSON text and its 2,000-byte guard; partitioning and sorting of a table
  Pipelines writes, which would let an id filter skip files; a stream's schema that can change.

## Settings

| setting                            | value                                                              | why                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sink roll interval                 | 60 s                                                               | the minimum for Iceberg sinks                                                                                                                                                                                                                                                                     |
| sink compression, row-group target | zstd, 32 MB                                                        | the 1 GB default made scans read whole files                                                                                                                                                                                                                                                      |
| partitioning                       | `day(__ingest_ts)`, the sink's own                                 | no sort order exists; filters on `time` prune by file statistics                                                                                                                                                                                                                                  |
| compaction                         | on, 128 MB target                                                  | a day's ~1,440 files per table merge into a handful                                                                                                                                                                                                                                               |
| snapshot expiration                | older than 1 day, keep 5                                           | replaced files are deleted a day after compaction                                                                                                                                                                                                                                                 |
| OTLP export                        | 100 %, traces and logs, to `telemetry-traces` and `telemetry-logs` | `apps/telemetry` itself exports nothing: it would export itself                                                                                                                                                                                                                                   |
| traces persisted in Cloudflare     | off for a deployment with a lake (`traces.persist: false`)         | kept there too, every span is billed a second time: $0.60 per million past 20 M a month, from 2026-10-01. Logs stay persisted: `prd-fault-alarm`, `debug-os-worker` and the Query Builder read Workers Logs                                                                                       |
| retention                          | everything is kept                                                 | Basin has no table lifetime, partition expiry or `DELETE` of its own. Its documented route is an Iceberg engine (Spark, PyIceberg; not DuckDB) deleting whole days of `__ingest_ts`, the partition, after which snapshot expiration removes the files. Untested against a sink that keeps writing |

## Failures

Nothing waits on telemetry, and no failure of it reaches a caller.

- **The platform hook** queues each event's row in its context's outbox
  (`core/os/src/platform-hook.ts`): one send is out at a time, with every row that was waiting, up
  to 4 MB. A send that fails loses its rows and is logged under its kind
  (`telemetry.platform-failure-send`, `telemetry.deploy-reset-send`, or an issue); the rows waiting,
  and those of a send that is out, are lost when the context resets, and nothing says so. An event that finds 8 MB
  already waiting, or whose row is over 1 MB, is dropped and counted (`telemetry.events-dropped`).
  The delivery loop hands the hook an event at least once, so a context that restarts before a
  delivery is recorded sends its row again (4 rows of 16,025 on one preview run): dedupe on the
  key.
- **`apps/telemetry`** answers 503 when the platform fails a send or the secret is wrong
  (`telemetry.secret-refused`), and a send that fails any other way escapes as a 500, so Cloudflare
  sends the batch again (it did through a 12-minute
  outage) and rotating the secret loses nothing. A batch it cannot read at all is answered 400
  (`telemetry.batch-unreadable`), since sending it again cannot help; a record that does not parse
  or whose row is over 1 MB, is skipped and counted (`telemetry.records-skipped`). A batch sent
  twice lands twice: dedupe on each table's key.
- **A stream** accepts a row that breaks its schema and drops it silently, so tests check every row
  against its schema, and the health job alerts on dropped rows.
- **The metrics copy** runs after the job's pages are posted. It copies the closed hours after a
  watermark in the job's state, 24 a run, and writes the watermark after each hour that is sent
  whole. A failed hour is sent again whole, so what had landed of it lands twice (`metrics` has no
  key). A point that does not parse is skipped and counted; an hour read short of its `count()` is
  not sent. With no watermark (a first run, a lost state), it starts at the last closed hour.
- **The alert check** (`scripts/monitors/telemetry.ts`) pages #error-pulse for: a rule over its
  line, judged over the 70 minutes before each hourly run on the one Worker the lake's `envs.ts`
  entry names (`alertRulesWorkerName`: main on dev, since every preview's tests wedge deliveries on
  purpose); a row one of the lake's four pipelines dropped; a pipeline or destination that is
  missing, stopped or failing; a pipeline that took records in and whose sink wrote none.

## Privacy

Rows keep payloads and log bodies: messages, email bodies, model output. An invocation's row in
`logs` keeps the whole URL, its query included, the request headers Cloudflare exports, and the
visitor's country, city, network and user agent; `spans` drops those. `core/os` is the OAuth
issuer, so a query can carry a one-time code; `observability.redactQueryString` in the Worker's
config would drop every query, from Workers Logs too. Deleting a project or a
context does not reach the lake; until a purge job exists, its rows stay. The OTLP secret sits in
plain text in the destination's config and can only append rows. Setup makes it once; to rotate it,
delete it from Doppler and run setup again.

## Setting up an account

`pnpm --dir apps/telemetry ensure-resources --env <env>` creates, idempotently, from
`apps/telemetry/schemas/`: the bucket and its catalog, compaction and snapshot expiration, a
stream, sink and pipeline per table, the Worker's secret, and the two OTLP destinations. A stream's
schema cannot change and a sink cannot adopt an existing table, so a column change is a new table
(`logs_v2`) and a new stream, sink and pipeline; delete the old ones once drained (an account allows
20 of each). An existing sink is taken by its name, so a catalog token minted anew does not reach
it: drop that table, its sink and its pipeline, and run setup again.
`.depot/workflows/deploy-telemetry.yml` deploys the Worker when a push to main changes it.

## What it adds, and what it touches

Per Cloudflare account with a lake (the dev/preview account alone today; `telemetryEnvs` has no
prd):

|                  |                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| R2               | one bucket, `iterate-telemetry`, with its Basin Catalog, compaction and snapshot expiration                         |
| Basin Pipelines  | four streams, four sinks, four pipelines (an account allows 20 of each)                                             |
| Workers          | one, `telemetry`: no storage, no Durable Object, no route but workers.dev                                           |
| Observability    | two OTLP destinations, `telemetry-traces` and `telemetry-logs`                                                      |
| Analytics Engine | one dataset, `iterate_metrics`                                                                                      |
| tokens           | the catalog token (Data Catalog write, the bucket's objects, SQL read) and the admin app's (Account Analytics Read) |
| Doppler          | project `telemetry` (the catalog token, the OTLP secret); `admin`'s `APP_CONFIG_METRICS__API_TOKEN`                 |
| the health job   | two steps an hour: the alert check and the metrics copy                                                             |

A `core/os` deployment takes part only when its `APP_CONFIG` names the lake's two bindings:
`telemetry: { eventsStreamBinding, metricsDatasetBinding }`. Unset, the default, it has no lake:
the platform hook is handed every durable event, as it was before the lake, and builds no row,
`metrics` writes nothing, and what is left is a
`WORKER_NAME` var, `iterate.project_id` and `iterate.path` on each context's spans, and two numbers
kept per fan-out row. A name the Worker holds no binding under throws at its first request, naming
the field: a lake that silently received nothing would look like a quiet day. For iterate's own
deployments the config generator writes `telemetry`, with the bindings and the two destinations,
for an `envs.ts` entry that names a lake (`telemetry:`); prd's names none, and a self-hosted
deployment's config has none of it.

Where the code is: `apps/telemetry` (the receiver and the account's setup), `scripts/monitors`
(the alerts and the copy), `apps/admin` (the page), and in core, `core/os` (the hook and its
outbox, the delivery loop's three metrics, the span attributes, the config's key and bindings) and
`core/lib` (`iterate/metrics`). To take it out of a deployment, drop `telemetry:` from its `envs.ts`
entry and deploy; the account's resources are deleted by hand.

## What it costs

Measured on the dev account on 2026-10-01, at list prices. One run of a preview's suites writes
about 516,000 spans, 52,000 log rows and 16,000 events: 400 MB of JSON in, 28 MB stored. The dev
account sees about 200 such runs a day, which sets the bill; prd writes a fortieth of that.

| a month                                                                                 | dev, every preview exporting | prd, at today's volume |
| --------------------------------------------------------------------------------------- | ---------------------------- | ---------------------- |
| OTLP export, $0.05 per million past 10 M each of spans, logs                            | $176                         | $4                     |
| Basin Pipelines, $0.04 a GB of JSON transformed, $0.06 a GB a sink writes, uncompressed | $127                         | $0–2                   |
| R2 storage, $0.015 a GB-month, growing while nothing is purged                          | $1, by a year $32            | under $1               |
| the `telemetry` Worker, compaction, catalog operations                                  | under $20                    | under $1               |
| Durable Object duration the hook's sends add                                            | under $20                    | about $1               |
| **the lake**                                                                            | **about $340**               | **about $5–9**         |
| traces persisted in Cloudflare, which a lake turns off                                  | $1,860 saved                 | $50 saved              |

The Pipelines line takes every pipeline's `SELECT *` for a transform, as Cloudflare's page does,
and a sink's bill for what its own counter says it wrote: 0.98 GB of the 3.95 GB of JSON the lake
took in over two days. Half of a run's spans are a Durable Object's storage operations.

## Queries

Each ran on PR 3478's preview (`pr3478-7cede58`, 2026-09-30) through Basin SQL's HTTP API, with the
catalog token; what each scanned and cost was measured on 2026-10-01, once
compaction had merged each table's files into six. Basin SQL answers every query with the bytes it
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

-- each Durable Object invocation's project, by the object's id (16 of 18 in the sample resolved)
-- scanned 1.9 MB, billed as 10 MB: $0.000025
SELECT m.project_id, m.path, count(*) AS invocations
FROM telemetry.logs l JOIN (
  SELECT object_id, max(project_id) AS project_id, max(path) AS path
  FROM telemetry.spans WHERE project_id IS NOT NULL GROUP BY object_id
) m ON CASE WHEN l.body_bytes < 2000 THEN json_get_str(l.body, 'cloudflare.durable_object.id') END = m.object_id
WHERE l.event = 'invocation' GROUP BY 1, 2

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
