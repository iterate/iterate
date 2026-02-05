---
state: backlog
priority: high
size: large
tags:
  - observability
  - metrics
  - cloudflare
  - pidnap
dependsOn:
  - pidnap-unify-processes-and-tasks
---

# Machine Metrics Pipeline: Daemon to Cloudflare Analytics Engine

Collect machine health metrics, pidnap process timing data, and container startup timings from sandbox machines, send them through the OS worker to Cloudflare's Analytics Engine (ClickHouse-backed).

## Problem

We lack visibility into:

- **Resource utilization**: CPU, memory, disk usage across the machine fleet
- **Process timing**: How long pidnap processes/tasks take to complete
- **Container startup**: Time from container entrypoint start to platform "ready" notification
- **Fleet health**: Patterns across machines (by org, project, machine type)

Currently:

- PostHog is only used for product analytics (machine_created, project_created), not operational metrics
- Machine metadata stores `daemonReadyAt` but no timing breakdown
- pidnap API returns process state but no timing data
- No centralized metrics storage or visualization

## Solution Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         Sandbox Container                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  pidnap (with timing instrumentation)                               │  │
│  │    - Task/process start/end timestamps                              │  │
│  │    - Resource metrics via /proc                                     │  │
│  └──────────────────────────────────┬──────────────────────────────────┘  │
│                                     │                                      │
│  ┌──────────────────────────────────▼──────────────────────────────────┐  │
│  │  daemon-backend (apps/daemon)                                       │  │
│  │    - Collects metrics from pidnap                                   │  │
│  │    - Reads /proc for CPU/memory                                     │  │
│  │    - Sends to worker via oRPC                                       │  │
│  └──────────────────────────────────┬──────────────────────────────────┘  │
└─────────────────────────────────────┼─────────────────────────────────────┘
                                      │ oRPC: reportMetrics()
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (apps/os/backend)                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  oRPC Router (orpc/router.ts)                                         │  │
│  │    - New endpoint: reportMetrics({ machineId, metrics })              │  │
│  └────────────────────────────────────┬──────────────────────────────────┘  │
│                                       │                                      │
│  ┌────────────────────────────────────▼──────────────────────────────────┐  │
│  │  Analytics Engine Binding                                              │  │
│  │    MACHINE_METRICS.writeDataPoint({                                   │  │
│  │      indexes: [machineId],                                            │  │
│  │      blobs: [orgId, projectId, machineType, ...],                     │  │
│  │      doubles: [cpuPercent, memoryMb, diskPercent, ...]                │  │
│  │    })                                                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Cloudflare Analytics Engine (ClickHouse)                        │
│                                                                              │
│  Query via SQL API:                                                          │
│  SELECT avg(double1) as avg_cpu FROM MACHINE_METRICS                        │
│  WHERE blob1 = 'org_xxx' AND timestamp > now() - interval '1 hour'          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Metrics to Collect

### 1. Resource Metrics (periodic, every 30s)

| Metric              | Type   | Source          | Notes             |
| ------------------- | ------ | --------------- | ----------------- |
| `cpu_percent`       | double | `/proc/stat`    | Overall CPU usage |
| `memory_used_mb`    | double | `/proc/meminfo` | Used memory in MB |
| `memory_total_mb`   | double | `/proc/meminfo` | Total memory      |
| `disk_used_percent` | double | `df` or statfs  | Disk usage        |

### 2. pidnap Process Metrics (on state change)

| Metric                | Type   | Source | Notes                          |
| --------------------- | ------ | ------ | ------------------------------ |
| `process_name`        | blob   | pidnap | Process identifier             |
| `process_state`       | blob   | pidnap | running, stopped, failed, etc. |
| `process_duration_ms` | double | pidnap | Time from start to exit        |
| `process_restarts`    | double | pidnap | Restart count                  |
| `exit_code`           | double | pidnap | Process exit code              |

### 3. Container Startup Timing (once per boot)

| Metric                | Type   | Source   | Notes                             |
| --------------------- | ------ | -------- | --------------------------------- |
| `entrypoint_start_ms` | double | pidnap   | Timestamp when entrypoint started |
| `tasks_complete_ms`   | double | pidnap   | When all tasks finished           |
| `daemon_ready_ms`     | double | daemon   | When reportStatus(ready) sent     |
| `time_to_ready_ms`    | double | computed | Total startup time                |

## Analytics Engine Schema Design

```typescript
// Dataset: MACHINE_METRICS
// Binding added to alchemy.run.ts

interface MachineMetricsDataPoint {
  indexes: [
    string, // machineId (sampling key)
  ];
  blobs: [
    string, // blob1: orgId
    string, // blob2: projectId
    string, // blob3: machineType (daytona|local-docker)
    string, // blob4: metricType (resource|process|startup)
    string, // blob5: processName (for process metrics)
    string, // blob6: processState (for process metrics)
    string, // blob7: reserved
    string, // blob8: reserved
  ];
  doubles: [
    number, // double1: cpuPercent | processDurationMs | timeToReadyMs
    number, // double2: memoryUsedMb | processRestarts | entrypointStartMs
    number, // double3: memoryTotalMb | exitCode | tasksCompleteMs
    number, // double4: diskUsedPercent | (reserved) | daemonReadyMs
    number, // double5: reserved
  ];
}
```

## Implementation Plan

### Phase 1: Analytics Engine Setup

1. Add Analytics Engine binding to `alchemy.run.ts`:

   ```typescript
   analytics_engine_datasets: [
     {
       binding: "MACHINE_METRICS",
       dataset: "machine_metrics",
     },
   ];
   ```

2. Add new oRPC endpoint in `apps/os/backend/orpc/router.ts`:
   ```typescript
   reportMetrics: o
     .input(v.object({
       machineId: v.string(),
       metrics: v.array(MetricDataPoint)
     }))
     .mutation(async ({ input, ctx }) => {
       // Write to Analytics Engine
       for (const metric of input.metrics) {
         ctx.env.MACHINE_METRICS.writeDataPoint({
           indexes: [input.machineId],
           blobs: [...],
           doubles: [...]
         });
       }
     })
   ```

### Phase 2: Daemon Metrics Collection

1. Add resource metrics collector in `apps/daemon`:

   ```typescript
   // lib/metrics-collector.ts
   async function collectResourceMetrics(): Promise<ResourceMetrics> {
     return {
       cpuPercent: await readCpuUsage(),
       memoryUsedMb: await readMemoryUsage(),
       diskUsedPercent: await readDiskUsage(),
     };
   }
   ```

2. Add periodic reporting (every 30s via setInterval or cron process)

3. Add process metrics via pidnap API integration

### Phase 3: pidnap Timing Instrumentation

Depends on `pidnap-unify-processes-and-tasks` for unified process abstraction.

1. Add timing data to process state:

   ```typescript
   interface ProcessTiming {
     startedAt: number;
     stoppedAt?: number;
     durationMs?: number;
   }
   ```

2. Emit timing on state transitions
3. Expose timing via API contract

### Phase 4: Startup Timing

1. Record `entrypoint_start_ms` at pidnap boot
2. Record `tasks_complete_ms` when all tasks done
3. Record `daemon_ready_ms` when reportStatus called
4. Compute and report `time_to_ready_ms`

## Open Questions

### Q1: Metrics Collection Frequency

**Question**: How often should we collect and report resource metrics?

**Options**:

1. **Every 30 seconds (Recommended)** - Balance between granularity and volume. At scale (1000 machines), this is ~2.9M data points/day. Analytics Engine handles this well and it's enough for alerting.
2. **Every 60 seconds** - Lower volume, sufficient for dashboards but may miss transient spikes.
3. **Every 10 seconds** - High granularity, useful for debugging but 8.6M data points/day per 1000 machines.
4. **Adaptive** - Higher frequency when issues detected, lower during normal operation. More complex.

**Recommendation**: Option 1 (30s). It's a common industry standard (Prometheus default scrape interval). Can adjust later based on volume/cost.

---

### Q2: Metrics Transport Mechanism

**Question**: How should daemon send metrics to the worker?

**Options**:

1. **oRPC via existing daemon→worker channel (Recommended)** - Reuse existing infrastructure. Already authenticated. Add batch endpoint to reduce overhead.
2. **Direct Analytics Engine API** - Daemon writes directly to Cloudflare. Requires exposing API credentials to sandbox, security concern.
3. **Durable Object intermediary** - Machine DO collects and batches metrics. More complexity, but enables aggregation.
4. **Separate metrics service** - Dedicated worker for metrics ingestion. Over-engineering for current scale.

**Recommendation**: Option 1. Simplest, reuses existing infrastructure, keeps secrets in the worker.

---

### Q3: CPU Metrics Collection Method

**Question**: How should we measure CPU usage in containers?

**Options**:

1. **Parse /proc/stat (Recommended)** - Standard Linux approach. Calculate delta between readings. Works in Docker and Daytona.
2. **cgroup stats** - More accurate for containerized workloads, but path varies by cgroup version (v1 vs v2).
3. **top/ps parsing** - Shell out to commands. Fragile, overhead of spawning processes.
4. **Node.js os.cpus()** - Only gives per-core times, not overall usage. Need to calculate ourselves anyway.

**Recommendation**: Option 1. Most portable, well-understood, minimal overhead.

---

### Q4: Process Timing Granularity

**Question**: What level of process timing detail should we capture?

**Options**:

1. **Start/end timestamps only (Recommended)** - Simple, covers most use cases. Duration = end - start.
2. **Phase-based timing** - Track each phase: spawning, running, exiting. More detail, more complexity.
3. **Full execution trace** - Include stdout/stderr timestamps, resource usage during execution. Significant overhead.

**Recommendation**: Option 1 for MVP. Can add phase timing later if needed for debugging specific issues.

---

### Q5: Handling Offline/Disconnected Machines

**Question**: What happens to metrics when machine can't reach worker?

**Options**:

1. **Drop metrics (Recommended for MVP)** - Simplest. Missing data is acceptable for monitoring dashboards. Alert on missing data instead.
2. **Local buffer with retry** - Queue metrics locally, send when reconnected. Risk of unbounded growth.
3. **Write to local disk, sync later** - Persist metrics to disk, background sync. Complex, disk space concerns.

**Recommendation**: Option 1 for MVP. Missing metrics for a disconnected machine is a valid signal that something is wrong.

---

### Q6: Analytics Engine Retention

**Question**: How long should we retain metrics in Analytics Engine?

**Options**:

1. **90 days (Recommended)** - Enough for trend analysis and incident review. Analytics Engine default-ish.
2. **30 days** - Shorter retention, lower storage cost, but limits historical analysis.
3. **1 year** - Long-term trend analysis, but may hit storage limits.
4. **Tiered: 7d full resolution, 90d aggregated** - Best of both worlds, but requires separate aggregation job.

**Recommendation**: Option 1. 90 days is a good balance. Can revisit based on actual storage costs.

---

### Q7: Dashboard/Visualization Approach

**Question**: How should we visualize these metrics?

**Options**:

1. **Grafana with Analytics Engine data source (Recommended)** - Industry standard. Can write custom data source plugin or use SQL API directly.
2. **Custom dashboard in iterate.com** - Tight integration, but significant frontend work.
3. **Cloudflare dashboard only** - Minimal effort, but limited customization.
4. **Export to external system** - Send to DataDog/NewRelic. Adds external dependency and cost.

**Recommendation**: Option 1 for internal use, Option 2 for customer-facing machine health page (future).

## Related Tasks

- `machine-health-metrics-clickhouse.md` - Original task (this supersedes/expands it)
- `machine-monitoring-durable-objects.md` - DO-based health monitoring (complementary)
- `pidnap-unify-processes-and-tasks.md` - Required for timing instrumentation

## Files to Modify

- `apps/os/alchemy.run.ts` - Add Analytics Engine binding
- `apps/os/backend/orpc/router.ts` - Add reportMetrics endpoint
- `apps/os/backend/orpc/contract.ts` - Add metrics schema
- `apps/daemon/server/` - Add metrics collection and reporting
- `packages/pidnap/src/manager.ts` - Add timing instrumentation
- `packages/pidnap/src/api/contract.ts` - Expose timing in API