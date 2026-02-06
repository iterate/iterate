---
state: backlog
priority: medium
size: medium
tags:
  - observability
  - posthog
  - cloudflare
  - data-warehouse
dependsOn:
  - machine-metrics-pipeline
---

# Cloudflare Analytics Engine to PostHog Data Warehouse Sync

Set up a data pipeline to sync machine metrics from Cloudflare's Analytics Engine (ClickHouse) into PostHog's data warehouse, enabling unified analytics across product events and operational metrics.

## Problem

Once we have machine metrics in Cloudflare Analytics Engine (`machine-metrics-pipeline.md`), we'll have two separate data stores:

1. **PostHog**: Product analytics (events, funnels, user behavior, machine_created, etc.)
2. **Cloudflare Analytics Engine**: Operational metrics (CPU, memory, process timing, startup times)

This separation means:

- Can't correlate product events with operational metrics
- Can't create unified dashboards
- Can't answer questions like "Do users who experience slow machine startups churn more?"
- Need separate tooling for product vs ops visibility

## Solution Overview

Sync Cloudflare Analytics Engine data into PostHog's data warehouse as a custom source, enabling SQL queries that JOIN product events with operational metrics.

```
┌────────────────────────────────────────────────────────────────────────────┐
│             Cloudflare Analytics Engine                                     │
│               (machine_metrics dataset)                                     │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │
                               │ 1. Query via SQL API
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                    Sync Worker / Scheduled Job                              │
│   - Query Analytics Engine SQL API for new data                            │
│   - Transform to Parquet/CSV format                                        │
│   - Upload to cloud storage (R2/S3)                                        │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │
                               │ 2. Upload to storage
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       Cloudflare R2 Bucket                                  │
│   posthog-exports/machine_metrics/                                         │
│     ├── 2026-02-05/data.parquet                                            │
│     ├── 2026-02-04/data.parquet                                            │
│     └── ...                                                                │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │
                               │ 3. PostHog reads from R2
                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     PostHog Data Warehouse                                  │
│                                                                             │
│  SELECT                                                                     │
│    e.distinct_id,                                                          │
│    e.event,                                                                │
│    m.avg_startup_time_ms                                                   │
│  FROM events e                                                             │
│  JOIN machine_metrics m ON e.properties.machine_id = m.machine_id          │
│  WHERE e.event = 'machine_created'                                         │
└────────────────────────────────────────────────────────────────────────────┘
```

## PostHog Data Warehouse Integration Options

PostHog's data warehouse supports several source types. For Cloudflare Analytics Engine data, the best approach is using a **self-hosted source** with Cloudflare R2.

### Why R2?

1. **Native Cloudflare integration** - Same account, no cross-cloud data transfer costs
2. **PostHog supports R2** - Built-in connector for Cloudflare R2 as a self-hosted source
3. **Control data freshness** - We control when and how often data is uploaded
4. **No managed connector fees** - Self-hosted sources are included in PostHog pricing

### Data Format

PostHog supports:

- **Parquet** (Recommended) - Columnar, compressed, fast queries
- **CSV** - Simple but larger and slower

## Implementation Plan

### Phase 1: R2 Bucket Setup

1. Create R2 bucket for PostHog exports:

   ```
   Bucket: iterate-posthog-exports
   Location: Auto (or same region as Analytics Engine)
   ```

2. Configure bucket access:
   - Create R2 API token with read access for PostHog
   - Store credentials securely

### Phase 2: Sync Worker

Create a Cloudflare Worker (or scheduled job) that:

1. Queries Analytics Engine SQL API for recent data
2. Transforms to Parquet format
3. Uploads to R2

```typescript
// apps/os/backend/cron/sync-metrics-to-posthog.ts

import { Hono } from "hono";

export const syncMetricsToPosthog = new Hono<{ Bindings: Env }>();

syncMetricsToPosthog.get("/trigger", async (c) => {
  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = c.env.CLOUDFLARE_ANALYTICS_API_TOKEN;

  // 1. Query Analytics Engine
  const query = `
    SELECT 
      timestamp,
      index1 as machine_id,
      blob1 as org_id,
      blob2 as project_id,
      blob3 as machine_type,
      blob4 as metric_type,
      blob5 as process_name,
      double1 as value1,
      double2 as value2,
      double3 as value3,
      double4 as value4
    FROM machine_metrics
    WHERE timestamp > now() - interval '1 day'
    FORMAT JSONEachRow
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "text/plain",
      },
      body: query,
    },
  );

  const data = await response.text();

  // 2. Convert to Parquet (using a library like parquetjs)
  const parquetBuffer = await convertToParquet(data);

  // 3. Upload to R2
  const date = new Date().toISOString().split("T")[0];
  await c.env.POSTHOG_EXPORTS.put(`machine_metrics/${date}/data.parquet`, parquetBuffer);

  return c.json({ success: true, date });
});
```

### Phase 3: PostHog Source Configuration

1. Go to PostHog → Data Warehouse → Sources
2. Add Cloudflare R2 source:
   - Bucket: `iterate-posthog-exports`
   - Access Key ID: (from R2 API token)
   - Secret Access Key: (from R2 API token)
   - Region: `auto`
   - Endpoint: `https://<account_id>.r2.cloudflarestorage.com`

3. Configure table:
   - Table name: `machine_metrics`
   - File pattern: `machine_metrics/**/*.parquet`
   - Schema: Auto-detect from Parquet

### Phase 4: Scheduling

Options for running the sync:

1. **Cloudflare Cron Triggers** - Built-in, simple
2. **External scheduler** - GitHub Actions, etc.
3. **Manual trigger** - For initial testing

Recommended: Cron Trigger running every 6 hours.

## Open Questions

### Q1: Sync Frequency

**Question**: How often should we sync data from Analytics Engine to PostHog?

**Options**:

1. **Every 6 hours (Recommended)** - Good balance between freshness and cost. PostHog queries are typically not real-time.
2. **Every hour** - More frequent updates, higher API/storage costs.
3. **Daily** - Simple, low cost, but data is always 0-24 hours stale.
4. **Real-time streaming** - Requires significant infrastructure (Kafka, etc.). Overkill for analytics use case.

**Recommendation**: Option 1. Operational metrics don't need real-time sync for product analytics correlation. 6 hours gives reasonable freshness.

---

### Q2: Data Deduplication Strategy

**Question**: How do we handle overlapping time windows and prevent duplicates?

**Options**:

1. **Append-only with timestamp filter (Recommended)** - Each sync pulls data from last sync timestamp. Simple but requires tracking state.
2. **Daily partitions, full replace** - Each day's data replaces previous. Simple, idempotent, but wastes bandwidth.
3. **Incremental with dedup at query time** - Upload all, use DISTINCT in queries. Simplest upload, but query overhead.
4. **Use Analytics Engine \_sample_interval** - Analytics Engine already deduplicates via sampling. May be sufficient.

**Recommendation**: Option 2 for MVP. Full daily partition replacement is idempotent and simple. Can optimize later if costs are high.

---

### Q3: Schema Mapping

**Question**: How should we map Analytics Engine schema to PostHog-friendly format?

**Options**:

1. **Flatten with meaningful column names (Recommended)** - Transform blob1→org_id, double1→cpu_percent, etc. Better query ergonomics.
2. **Keep raw schema** - blob1, blob2, double1, etc. Minimal transformation, but harder to query.
3. **Multiple tables by metric type** - Separate tables for resource_metrics, process_metrics, startup_metrics. Cleaner but more complex.

**Recommendation**: Option 1. Named columns make SQL queries much more readable. The transformation happens in the sync worker.

---

### Q4: Historical Backfill

**Question**: How do we handle initial data load and historical data?

**Options**:

1. **Start fresh, no backfill (Recommended for MVP)** - Begin syncing from deployment date. Simplest.
2. **Backfill available history** - Pull all data from Analytics Engine (90 day retention). One-time large upload.
3. **Selective backfill** - Pull last 30 days only. Balance between history and volume.

**Recommendation**: Option 1 for MVP. Analytics Engine has ~90 day retention anyway. Can backfill later if needed.

---

### Q5: PostHog Data Warehouse vs External Tool

**Question**: Should we use PostHog's built-in data warehouse or a dedicated ETL tool?

**Options**:

1. **PostHog Data Warehouse + R2 (Recommended)** - Native integration, no additional services, unified analytics platform.
2. **Airbyte** - Powerful ETL tool, has both PostHog and ClickHouse connectors. But adds infrastructure complexity.
3. **Hightouch** - Reverse ETL focus, good for ClickHouse→PostHog. SaaS pricing, another vendor.
4. **Custom pipeline to self-hosted ClickHouse** - Full control, but significant infrastructure overhead.

**Recommendation**: Option 1. PostHog's data warehouse is sufficient for our use case. Keeps everything in one platform. Can evaluate Airbyte later if we need more complex transformations.

---

### Q6: Data Retention Alignment

**Question**: How do we handle retention differences between Analytics Engine (90 days) and PostHog (varies)?

**Options**:

1. **Match Analytics Engine (90 days) (Recommended)** - Keep synced data for 90 days. Consistent with source.
2. **Keep indefinitely in PostHog** - R2 storage is cheap. Historical data for long-term trends.
3. **Shorter in PostHog (30 days)** - If we only need recent correlations.

**Recommendation**: Option 1. Match source retention. PostHog/R2 storage is cheap enough that 90 days is fine.

---

### Q7: Handling Metric Aggregation

**Question**: Should we sync raw data points or pre-aggregate?

**Options**:

1. **Raw data points (Recommended for MVP)** - Maximum flexibility in PostHog queries. Let PostHog aggregate.
2. **Pre-aggregated (hourly/daily)** - Reduces data volume significantly. But loses granularity.
3. **Both** - Raw for recent, aggregated for historical. Complex sync logic.

**Recommendation**: Option 1. Raw data gives maximum flexibility. If volume becomes a problem, add aggregation later.

---

### Q8: Worker vs External Service Architecture

**Question**: Where should the sync job run?

**Options**:

1. **Cloudflare Worker with Cron Trigger (Recommended)** - Native, serverless, same platform as Analytics Engine.
2. **Separate service (e.g., in daemon)** - More control, but runs in sandbox, network considerations.
3. **GitHub Actions scheduled workflow** - Simple, external, but adds latency and dependency.
4. **Dedicated VM/container** - Overkill for a periodic sync job.

**Recommendation**: Option 1. Cloudflare Workers are ideal for this. Same account = easy auth, Cron Triggers = reliable scheduling, R2 bindings = fast uploads.

## Example PostHog Queries After Sync

Once data is synced, we can run queries like:

```sql
-- Correlation: startup time vs user retention
SELECT
  CASE
    WHEN m.time_to_ready_ms < 30000 THEN 'fast (<30s)'
    WHEN m.time_to_ready_ms < 60000 THEN 'medium (30-60s)'
    ELSE 'slow (>60s)'
  END as startup_speed,
  COUNT(DISTINCT e.distinct_id) as users,
  COUNT(DISTINCT CASE WHEN retained.distinct_id IS NOT NULL THEN e.distinct_id END) as retained_users
FROM events e
JOIN machine_metrics m ON e.properties.machine_id = m.machine_id
LEFT JOIN (
  SELECT DISTINCT distinct_id
  FROM events
  WHERE event = 'session_started'
    AND timestamp > now() - interval '7 days'
) retained ON e.distinct_id = retained.distinct_id
WHERE e.event = 'machine_created'
  AND e.timestamp > now() - interval '30 days'
  AND m.metric_type = 'startup'
GROUP BY startup_speed
```

```sql
-- Which orgs have the most machine health issues?
SELECT
  m.org_id,
  COUNT(*) as unhealthy_events,
  AVG(m.cpu_percent) as avg_cpu_when_unhealthy
FROM machine_metrics m
WHERE m.metric_type = 'resource'
  AND (m.cpu_percent > 90 OR m.memory_percent > 90)
GROUP BY m.org_id
ORDER BY unhealthy_events DESC
```

## Related Tasks

- `machine-metrics-pipeline.md` - Source of the data being synced
- `machine-health-metrics-clickhouse.md` - Original task (this extends it)

## Files to Create/Modify

- `apps/os/backend/cron/sync-metrics-to-posthog.ts` - New sync worker
- `apps/os/alchemy.run.ts` - Add R2 bucket binding, cron trigger
- `apps/os/backend/lib/parquet.ts` - Parquet conversion utilities (or use existing library)

## Dependencies

- Cloudflare R2 bucket
- PostHog data warehouse access
- Analytics Engine SQL API token
- `machine-metrics-pipeline` implemented first
