/**
 * HTML Report Generator for Benchmark Results
 *
 * Generates an HTML report with Chart.js visualizations from SQLite benchmark data.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

interface RunInfo {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  machinesPerConfig: number;
  requestsPerMachine: number;
  batchSize: number;
  restartCycles: number;
  configJson: string | null;
}

interface SandboxInfo {
  id: string;
  configName: string;
  provider: string;
  region: string | null;
  sandboxIndex: number;
  cpu: number | null;
  memoryMb: number | null;
  dockerfile: string | null;
}

interface Measurement {
  sandboxId: string;
  configName: string;
  region: string | null;
  measurementType: string;
  sequenceIndex: number;
  durationMs: number | null;
  error: string | null;
}

interface ReportData {
  run: RunInfo;
  sandboxes: SandboxInfo[];
  measurements: Measurement[];
  stats: {
    coldBoot: Stats;
    restart: Stats;
    requestLatency: Stats;
    byConfig: Record<string, { coldBoot: Stats; restart: Stats; requestLatency: Stats }>;
    byRegion: Record<string, { coldBoot: Stats; restart: Stats; requestLatency: Stats }>;
  };
}

interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stdDev: number;
}

function calculateStats(values: number[]): Stats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;

  const squaredDiffs = sorted.map((v) => (v - mean) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / sorted.length;
  const stdDev = Math.sqrt(variance);

  const percentile = (p: number) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  };

  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(mean * 100) / 100,
    median: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    stdDev: Math.round(stdDev * 100) / 100,
  };
}

function loadReportData(dbPath: string, runId?: string): ReportData {
  const db = new Database(dbPath, { readonly: true });

  // Get run info (latest if not specified)
  const runQuery = runId
    ? db.prepare("SELECT * FROM runs WHERE id = ?")
    : db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1");

  const run = (runId ? runQuery.get(runId) : runQuery.get()) as {
    id: string;
    started_at: string;
    finished_at: string | null;
    machines_per_config: number;
    requests_per_machine: number;
    batch_size: number;
    restart_cycles: number;
    config_json: string | null;
  };

  if (!run) {
    throw new Error("No benchmark run found in database");
  }

  const runInfo: RunInfo = {
    id: run.id,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    machinesPerConfig: run.machines_per_config,
    requestsPerMachine: run.requests_per_machine,
    batchSize: run.batch_size,
    restartCycles: run.restart_cycles,
    configJson: run.config_json,
  };

  // Get sandboxes for this run
  const sandboxesQuery = db.prepare(`
    SELECT id, config_name, provider, region, sandbox_index, cpu, memory_mb, dockerfile
    FROM sandboxes
    WHERE run_id = ?
    ORDER BY config_name, sandbox_index
  `);

  const sandboxes = sandboxesQuery.all(run.id) as Array<{
    id: string;
    config_name: string;
    provider: string;
    region: string | null;
    sandbox_index: number;
    cpu: number | null;
    memory_mb: number | null;
    dockerfile: string | null;
  }>;

  const sandboxInfos: SandboxInfo[] = sandboxes.map((s) => ({
    id: s.id,
    configName: s.config_name,
    provider: s.provider,
    region: s.region,
    sandboxIndex: s.sandbox_index,
    cpu: s.cpu,
    memoryMb: s.memory_mb,
    dockerfile: s.dockerfile,
  }));

  // Get measurements with sandbox info
  const measurementsQuery = db.prepare(`
    SELECT
      m.sandbox_id,
      s.config_name,
      s.region,
      m.measurement_type,
      m.sequence_index,
      m.duration_ms,
      m.error
    FROM measurements m
    JOIN sandboxes s ON m.sandbox_id = s.id
    WHERE s.run_id = ?
    ORDER BY s.config_name, s.sandbox_index, m.measurement_type, m.sequence_index
  `);

  const measurements = measurementsQuery.all(run.id) as Array<{
    sandbox_id: string;
    config_name: string;
    region: string | null;
    measurement_type: string;
    sequence_index: number;
    duration_ms: number | null;
    error: string | null;
  }>;

  const measurementInfos: Measurement[] = measurements.map((m) => ({
    sandboxId: m.sandbox_id,
    configName: m.config_name,
    region: m.region,
    measurementType: m.measurement_type,
    sequenceIndex: m.sequence_index,
    durationMs: m.duration_ms,
    error: m.error,
  }));

  db.close();

  // Calculate stats
  const coldBootValues = measurementInfos
    .filter((m) => m.measurementType === "cold_boot" && m.durationMs !== null)
    .map((m) => m.durationMs!);

  const restartValues = measurementInfos
    .filter((m) => m.measurementType === "restart" && m.durationMs !== null)
    .map((m) => m.durationMs!);

  const latencyValues = measurementInfos
    .filter((m) => m.measurementType === "request_latency" && m.durationMs !== null)
    .map((m) => m.durationMs!);

  // Stats by config
  const configs = [...new Set(sandboxInfos.map((s) => s.configName))];
  const byConfig: Record<string, { coldBoot: Stats; restart: Stats; requestLatency: Stats }> = {};

  for (const config of configs) {
    const configMeasurements = measurementInfos.filter((m) => m.configName === config);
    byConfig[config] = {
      coldBoot: calculateStats(
        configMeasurements
          .filter((m) => m.measurementType === "cold_boot" && m.durationMs !== null)
          .map((m) => m.durationMs!),
      ),
      restart: calculateStats(
        configMeasurements
          .filter((m) => m.measurementType === "restart" && m.durationMs !== null)
          .map((m) => m.durationMs!),
      ),
      requestLatency: calculateStats(
        configMeasurements
          .filter((m) => m.measurementType === "request_latency" && m.durationMs !== null)
          .map((m) => m.durationMs!),
      ),
    };
  }

  // Stats by region
  const regions = [
    ...new Set(sandboxInfos.map((s) => s.region).filter((r) => r !== null)),
  ] as string[];
  const byRegion: Record<string, { coldBoot: Stats; restart: Stats; requestLatency: Stats }> = {};

  for (const region of regions) {
    const regionMeasurements = measurementInfos.filter((m) => m.region === region);
    byRegion[region] = {
      coldBoot: calculateStats(
        regionMeasurements
          .filter((m) => m.measurementType === "cold_boot" && m.durationMs !== null)
          .map((m) => m.durationMs!),
      ),
      restart: calculateStats(
        regionMeasurements
          .filter((m) => m.measurementType === "restart" && m.durationMs !== null)
          .map((m) => m.durationMs!),
      ),
      requestLatency: calculateStats(
        regionMeasurements
          .filter((m) => m.measurementType === "request_latency" && m.durationMs !== null)
          .map((m) => m.durationMs!),
      ),
    };
  }

  return {
    run: runInfo,
    sandboxes: sandboxInfos,
    measurements: measurementInfos,
    stats: {
      coldBoot: calculateStats(coldBootValues),
      restart: calculateStats(restartValues),
      requestLatency: calculateStats(latencyValues),
      byConfig,
      byRegion,
    },
  };
}

// Interface for config metadata used in tooltips
interface ConfigMetadata {
  name: string;
  provider: string;
  cpu: number | null;
  memoryMb: number | null;
  region: string | null;
  dockerfile: string | null;
  sandboxCount: number;
  stats: {
    coldBoot: Stats;
    restart: Stats;
    requestLatency: Stats;
  };
}

function generateHtmlReport(data: ReportData): string {
  const { run, sandboxes, measurements, stats } = data;

  // Build config metadata for tooltips
  const configMetadata: Record<string, ConfigMetadata> = {};
  for (const [name, configStats] of Object.entries(stats.byConfig)) {
    const configSandboxes = sandboxes.filter((s) => s.configName === name);
    const firstSandbox = configSandboxes[0];
    configMetadata[name] = {
      name,
      provider: firstSandbox?.provider ?? "unknown",
      cpu: firstSandbox?.cpu ?? null,
      memoryMb: firstSandbox?.memoryMb ?? null,
      region: firstSandbox?.region ?? null,
      dockerfile: firstSandbox?.dockerfile ?? null,
      sandboxCount: configSandboxes.length,
      stats: configStats,
    };
  }

  // Prepare chart data
  const coldBootByConfig = Object.entries(stats.byConfig).map(([name, s]) => ({
    name,
    mean: s.coldBoot.mean,
    p95: s.coldBoot.p95,
  }));

  const latencyByConfig = Object.entries(stats.byConfig).map(([name, s]) => ({
    name,
    mean: s.requestLatency.mean,
    p95: s.requestLatency.p95,
    p99: s.requestLatency.p99,
  }));

  // Restart data for chart
  const restartByConfig = Object.entries(stats.byConfig)
    .filter(([, s]) => s.restart.count > 0)
    .map(([name, s]) => ({
      name,
      mean: s.restart.mean,
      p95: s.restart.p95,
    }));

  const hasRestartData = restartByConfig.length > 0;

  const latencyHistogramData = measurements
    .filter((m) => m.measurementType === "request_latency" && m.durationMs !== null)
    .map((m) => m.durationMs!);

  // Create histogram buckets
  const histogramBuckets = createHistogramBuckets(latencyHistogramData, 20);

  // Get latency by region if available
  const regionNames = Object.keys(stats.byRegion);
  const hasRegions = regionNames.length > 0;

  const latencyByRegion = hasRegions
    ? regionNames.map((region) => ({
        region,
        mean: stats.byRegion[region].requestLatency.mean,
        p95: stats.byRegion[region].requestLatency.p95,
      }))
    : [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sandbox Benchmark Report - ${run.id.slice(0, 8)}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
      color: #333;
    }
    h1, h2, h3 { color: #1a1a1a; }
    h1 { border-bottom: 3px solid #007acc; padding-bottom: 10px; }
    .header {
      background: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .meta { color: #666; font-size: 14px; }
    .meta span { margin-right: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .card h3 { margin-top: 0; color: #007acc; }
    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .stat {
      text-align: center;
      padding: 10px;
      background: #f8f9fa;
      border-radius: 4px;
    }
    .stat-value { font-size: 24px; font-weight: bold; color: #007acc; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; }
    .chart-container { position: relative; height: 300px; margin-top: 20px; }
    .chart-container-large { position: relative; height: 400px; margin-top: 20px; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 14px;
    }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; }
    tr:hover { background: #f8f9fa; }
    .success { color: #28a745; }
    .error { color: #dc3545; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-eu { background: #e3f2fd; color: #1565c0; }
    .badge-us { background: #fff3e0; color: #ef6c00; }
    .full-width { grid-column: 1 / -1; }
    .config-json {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre;
      max-height: 500px;
      overflow-y: auto;
    }
    .config-table td { font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
    .config-table td:first-child { font-weight: 600; color: #007acc; }
    details { margin-bottom: 10px; }
    details summary { cursor: pointer; font-weight: 600; padding: 8px 0; }
    details summary:hover { color: #007acc; }

    /* Enhanced table row tooltips */
    .tooltip-row {
      cursor: pointer;
      position: relative;
    }
    .tooltip-row:hover {
      background: #e8f4fd !important;
    }
    .tooltip-row .config-tooltip {
      display: none;
      position: absolute;
      left: 100%;
      top: 0;
      margin-left: 10px;
      background: #1e1e1e;
      color: #e0e0e0;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 1000;
      min-width: 280px;
      white-space: nowrap;
      font-size: 13px;
      line-height: 1.6;
      border: 1px solid #007acc;
    }
    .tooltip-row:hover .config-tooltip {
      display: block;
    }
    .config-tooltip h4 {
      margin: 0 0 8px 0;
      color: #007acc;
      font-size: 14px;
      border-bottom: 1px solid #444;
      padding-bottom: 6px;
    }
    .config-tooltip .tooltip-section {
      margin-bottom: 8px;
    }
    .config-tooltip .tooltip-section:last-child {
      margin-bottom: 0;
    }
    .config-tooltip .tooltip-label {
      color: #888;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .config-tooltip .tooltip-value {
      color: #fff;
      font-weight: 500;
    }
    .config-tooltip .tooltip-stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px 16px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #444;
    }
    .config-tooltip .tooltip-stat {
      display: flex;
      justify-content: space-between;
    }

    /* Info icon for tooltip hint */
    .info-icon {
      display: inline-block;
      width: 14px;
      height: 14px;
      background: #007acc;
      color: white;
      border-radius: 50%;
      font-size: 10px;
      text-align: center;
      line-height: 14px;
      margin-left: 4px;
      cursor: help;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🚀 Sandbox Benchmark Report</h1>
    <div class="meta">
      <span><strong>Run ID:</strong> ${run.id}</span>
      <span><strong>Started:</strong> ${new Date(run.startedAt).toLocaleString()}</span>
      ${run.finishedAt ? `<span><strong>Finished:</strong> ${new Date(run.finishedAt).toLocaleString()}</span>` : ""}
    </div>
    <div class="meta" style="margin-top: 10px;">
      <span><strong>Sandboxes:</strong> ${sandboxes.length}</span>
      <span><strong>Requests/Machine:</strong> ${run.requestsPerMachine}</span>
      <span><strong>Restart Cycles:</strong> ${run.restartCycles}</span>
      <span><strong>Total Measurements:</strong> ${measurements.length}</span>
    </div>
  </div>

  ${run.configJson ? generateConfigSection(run.configJson) : ""}

  <h2>📊 Summary Statistics</h2>
  <div class="grid">
    <div class="card">
      <h3>Cold Boot Time</h3>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value">${stats.coldBoot.mean.toFixed(0)}</div>
          <div class="stat-label">Mean (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.coldBoot.median.toFixed(0)}</div>
          <div class="stat-label">Median (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.coldBoot.p95.toFixed(0)}</div>
          <div class="stat-label">P95 (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.coldBoot.count}</div>
          <div class="stat-label">Samples</div>
        </div>
      </div>
    </div>

    ${
      stats.restart.count > 0
        ? `
    <div class="card">
      <h3>Restart Time</h3>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value">${stats.restart.mean.toFixed(0)}</div>
          <div class="stat-label">Mean (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.restart.median.toFixed(0)}</div>
          <div class="stat-label">Median (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.restart.p95.toFixed(0)}</div>
          <div class="stat-label">P95 (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.restart.count}</div>
          <div class="stat-label">Samples</div>
        </div>
      </div>
    </div>
    `
        : ""
    }

    <div class="card">
      <h3>Request Latency</h3>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value">${stats.requestLatency.mean.toFixed(0)}</div>
          <div class="stat-label">Mean (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.requestLatency.median.toFixed(0)}</div>
          <div class="stat-label">Median (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.requestLatency.p95.toFixed(0)}</div>
          <div class="stat-label">P95 (ms)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${stats.requestLatency.count}</div>
          <div class="stat-label">Samples</div>
        </div>
      </div>
    </div>
  </div>

  <h2>📈 Charts</h2>
  <div class="grid">
    <div class="card">
      <h3>Cold Boot Time by Configuration</h3>
      <div class="chart-container">
        <canvas id="coldBootChart"></canvas>
      </div>
    </div>

    <div class="card">
      <h3>Request Latency by Configuration</h3>
      <div class="chart-container">
        <canvas id="latencyConfigChart"></canvas>
      </div>
    </div>

    ${
      hasRestartData
        ? `
    <div class="card">
      <h3>Restart Time by Configuration</h3>
      <div class="chart-container">
        <canvas id="restartChart"></canvas>
      </div>
    </div>
    `
        : ""
    }

    <div class="card full-width">
      <h3>Request Latency Distribution</h3>
      <div class="chart-container-large">
        <canvas id="latencyHistogram"></canvas>
      </div>
    </div>

    ${
      hasRegions
        ? `
    <div class="card full-width">
      <h3>Request Latency by Region</h3>
      <div class="chart-container">
        <canvas id="latencyRegionChart"></canvas>
      </div>
    </div>
    `
        : ""
    }
  </div>

  <h2>📋 Detailed Results</h2>
  <div class="card" style="overflow: visible;">
    <h3>Results by Configuration <span class="info-icon" title="Hover over rows for detailed config info">i</span></h3>
    <table style="overflow: visible;">
      <thead>
        <tr>
          <th>Configuration</th>
          <th>Cold Boot (mean)</th>
          <th>Cold Boot (p95)</th>
          <th>Restart (mean)</th>
          <th>Latency (mean)</th>
          <th>Latency (p95)</th>
          <th>Latency (p99)</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(stats.byConfig)
          .map(([name, s]) => {
            const meta = configMetadata[name];
            return `
          <tr class="tooltip-row">
            <td><strong>${name}</strong></td>
            <td>${s.coldBoot.mean.toFixed(0)} ms</td>
            <td>${s.coldBoot.p95.toFixed(0)} ms</td>
            <td>${s.restart.count > 0 ? s.restart.mean.toFixed(0) + " ms" : "-"}</td>
            <td>${s.requestLatency.mean.toFixed(0)} ms</td>
            <td>${s.requestLatency.p95.toFixed(0)} ms</td>
            <td>${s.requestLatency.p99.toFixed(0)} ms</td>
            <div class="config-tooltip">
              <h4>${name}</h4>
              <div class="tooltip-section">
                <div class="tooltip-label">Provider</div>
                <div class="tooltip-value">${meta?.provider?.toUpperCase() ?? "Unknown"}</div>
              </div>
              <div class="tooltip-section">
                <div class="tooltip-label">Resources</div>
                <div class="tooltip-value">${meta?.cpu ?? "N/A"} CPU • ${meta?.memoryMb ? meta.memoryMb + " MB" : "N/A"} RAM</div>
              </div>
              <div class="tooltip-section">
                <div class="tooltip-label">Region</div>
                <div class="tooltip-value">${meta?.region ?? "default"}</div>
              </div>
              <div class="tooltip-section">
                <div class="tooltip-label">Dockerfile</div>
                <div class="tooltip-value">${meta?.dockerfile?.split("/").pop() ?? "N/A"}</div>
              </div>
              <div class="tooltip-section">
                <div class="tooltip-label">Sandboxes Tested</div>
                <div class="tooltip-value">${meta?.sandboxCount ?? 0}</div>
              </div>
              <div class="tooltip-stats">
                <div class="tooltip-stat"><span>Min Cold Boot:</span> <span>${s.coldBoot.min.toFixed(0)} ms</span></div>
                <div class="tooltip-stat"><span>Max Cold Boot:</span> <span>${s.coldBoot.max.toFixed(0)} ms</span></div>
                <div class="tooltip-stat"><span>Min Latency:</span> <span>${s.requestLatency.min.toFixed(0)} ms</span></div>
                <div class="tooltip-stat"><span>Max Latency:</span> <span>${s.requestLatency.max.toFixed(0)} ms</span></div>
                <div class="tooltip-stat"><span>Std Dev (Boot):</span> <span>${s.coldBoot.stdDev.toFixed(1)} ms</span></div>
                <div class="tooltip-stat"><span>Std Dev (Lat):</span> <span>${s.requestLatency.stdDev.toFixed(1)} ms</span></div>
              </div>
            </div>
          </tr>
        `;
          })
          .join("")}
      </tbody>
    </table>
  </div>

  ${
    hasRegions
      ? `
  <div class="card">
    <h3>Results by Region</h3>
    <table>
      <thead>
        <tr>
          <th>Region</th>
          <th>Cold Boot (mean)</th>
          <th>Latency (mean)</th>
          <th>Latency (p95)</th>
          <th>Samples</th>
        </tr>
      </thead>
      <tbody>
        ${regionNames
          .map(
            (region) => `
          <tr>
            <td><span class="badge ${region.startsWith("eu") ? "badge-eu" : "badge-us"}">${region}</span></td>
            <td>${stats.byRegion[region].coldBoot.mean.toFixed(0)} ms</td>
            <td>${stats.byRegion[region].requestLatency.mean.toFixed(0)} ms</td>
            <td>${stats.byRegion[region].requestLatency.p95.toFixed(0)} ms</td>
            <td>${stats.byRegion[region].requestLatency.count}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  </div>
  `
      : ""
  }

  <div class="card">
    <h3>Individual Sandbox Results</h3>
    <table>
      <thead>
        <tr>
          <th>Sandbox</th>
          <th>Config</th>
          <th>Region</th>
          <th>Cold Boot</th>
          <th>Restarts</th>
          <th>Requests</th>
          <th>Avg Latency</th>
        </tr>
      </thead>
      <tbody>
        ${sandboxes
          .map((s) => {
            const sbMeasurements = measurements.filter((m) => m.sandboxId === s.id);
            const coldBoot = sbMeasurements.find((m) => m.measurementType === "cold_boot");
            const restarts = sbMeasurements.filter((m) => m.measurementType === "restart");
            const requests = sbMeasurements.filter((m) => m.measurementType === "request_latency");
            const avgLatency =
              requests.length > 0
                ? requests
                    .filter((r) => r.durationMs !== null)
                    .reduce((sum, r) => sum + r.durationMs!, 0) /
                  requests.filter((r) => r.durationMs !== null).length
                : 0;
            return `
          <tr>
            <td>${s.configName}#${s.sandboxIndex}</td>
            <td>${s.configName}</td>
            <td>${s.region ? `<span class="badge ${s.region.startsWith("eu") ? "badge-eu" : "badge-us"}">${s.region}</span>` : "-"}</td>
            <td class="${coldBoot?.error ? "error" : "success"}">${coldBoot?.durationMs ? coldBoot.durationMs.toFixed(0) + " ms" : coldBoot?.error || "-"}</td>
            <td>${restarts.length > 0 ? restarts.filter((r) => !r.error).length + "/" + restarts.length : "-"}</td>
            <td>${requests.filter((r) => !r.error).length}/${requests.length}</td>
            <td>${avgLatency > 0 ? avgLatency.toFixed(0) + " ms" : "-"}</td>
          </tr>
        `;
          })
          .join("")}
      </tbody>
    </table>
  </div>

  <script>
    // Chart.js configuration
    Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

    // Configuration metadata for tooltips
    const configMetadata = ${JSON.stringify(configMetadata, null, 2)};

    // Custom tooltip configuration for config-based charts
    function createConfigTooltip(metricType) {
      return {
        enabled: true,
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        titleColor: '#fff',
        bodyColor: '#e0e0e0',
        borderColor: '#007acc',
        borderWidth: 1,
        padding: 12,
        titleFont: { size: 14, weight: 'bold' },
        bodyFont: { size: 12 },
        displayColors: true,
        callbacks: {
          title: function(tooltipItems) {
            return tooltipItems[0].label;
          },
          afterTitle: function(tooltipItems) {
            const configName = tooltipItems[0].label;
            const config = configMetadata[configName];
            if (!config) return '';
            return '─────────────────────';
          },
          beforeBody: function(tooltipItems) {
            const configName = tooltipItems[0].label;
            const config = configMetadata[configName];
            if (!config) return '';
            const lines = [
              'Provider: ' + config.provider.toUpperCase(),
              'CPU: ' + (config.cpu || 'N/A') + ' cores',
              'Memory: ' + (config.memoryMb ? config.memoryMb + ' MB' : 'N/A'),
              'Region: ' + (config.region || 'default'),
              'Sandboxes: ' + config.sandboxCount,
            ];
            if (config.dockerfile) {
              const dockerShort = config.dockerfile.split('/').pop() || config.dockerfile;
              lines.push('Dockerfile: ' + dockerShort);
            }
            return lines.join('\\n');
          },
          label: function(context) {
            return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + ' ms';
          },
          afterBody: function(tooltipItems) {
            const configName = tooltipItems[0].label;
            const config = configMetadata[configName];
            if (!config || !config.stats) return '';

            const stats = config.stats[metricType];
            if (!stats || stats.count === 0) return '';

            return [
              '',
              '── All ' + metricType.replace(/([A-Z])/g, ' $1').trim() + ' Stats ──',
              'Min: ' + stats.min.toFixed(0) + ' ms',
              'Max: ' + stats.max.toFixed(0) + ' ms',
              'Median: ' + stats.median.toFixed(0) + ' ms',
              'Std Dev: ' + stats.stdDev.toFixed(1) + ' ms',
              'Samples: ' + stats.count
            ].join('\\n');
          }
        }
      };
    }

    // Cold Boot Chart with enhanced tooltips
    new Chart(document.getElementById('coldBootChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(coldBootByConfig.map((c) => c.name))},
        datasets: [{
          label: 'Mean (ms)',
          data: ${JSON.stringify(coldBootByConfig.map((c) => c.mean))},
          backgroundColor: 'rgba(0, 122, 204, 0.7)',
        }, {
          label: 'P95 (ms)',
          data: ${JSON.stringify(coldBootByConfig.map((c) => c.p95))},
          backgroundColor: 'rgba(0, 122, 204, 0.3)',
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top' },
          tooltip: createConfigTooltip('coldBoot')
        },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Time (ms)' } } }
      }
    });

    // Latency by Config Chart with enhanced tooltips
    new Chart(document.getElementById('latencyConfigChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(latencyByConfig.map((c) => c.name))},
        datasets: [{
          label: 'Mean (ms)',
          data: ${JSON.stringify(latencyByConfig.map((c) => c.mean))},
          backgroundColor: 'rgba(40, 167, 69, 0.7)',
        }, {
          label: 'P95 (ms)',
          data: ${JSON.stringify(latencyByConfig.map((c) => c.p95))},
          backgroundColor: 'rgba(40, 167, 69, 0.4)',
        }, {
          label: 'P99 (ms)',
          data: ${JSON.stringify(latencyByConfig.map((c) => c.p99))},
          backgroundColor: 'rgba(40, 167, 69, 0.2)',
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top' },
          tooltip: createConfigTooltip('requestLatency')
        },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Time (ms)' } } }
      }
    });

    ${
      hasRestartData
        ? `
    // Restart Chart with enhanced tooltips
    new Chart(document.getElementById('restartChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(restartByConfig.map((c) => c.name))},
        datasets: [{
          label: 'Mean (ms)',
          data: ${JSON.stringify(restartByConfig.map((c) => c.mean))},
          backgroundColor: 'rgba(255, 159, 64, 0.7)',
        }, {
          label: 'P95 (ms)',
          data: ${JSON.stringify(restartByConfig.map((c) => c.p95))},
          backgroundColor: 'rgba(255, 159, 64, 0.3)',
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top' },
          tooltip: createConfigTooltip('restart')
        },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Time (ms)' } } }
      }
    });
    `
        : ""
    }

    // Latency Histogram with enhanced tooltips
    new Chart(document.getElementById('latencyHistogram'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(histogramBuckets.labels)},
        datasets: [{
          label: 'Request Count',
          data: ${JSON.stringify(histogramBuckets.counts)},
          backgroundColor: 'rgba(108, 117, 125, 0.7)',
          borderColor: 'rgba(108, 117, 125, 1)',
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Request Latency Distribution (ms)' },
          tooltip: {
            backgroundColor: 'rgba(30, 30, 30, 0.95)',
            borderColor: '#6c757d',
            borderWidth: 1,
            padding: 10,
            callbacks: {
              title: function(tooltipItems) {
                return 'Latency Range: ' + tooltipItems[0].label + ' ms';
              },
              label: function(context) {
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const percentage = ((context.parsed.y / total) * 100).toFixed(1);
                return [
                  'Count: ' + context.parsed.y + ' requests',
                  'Percentage: ' + percentage + '%'
                ];
              }
            }
          }
        },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Count' } },
          x: { title: { display: true, text: 'Latency (ms)' } }
        }
      }
    });

    ${
      hasRegions
        ? `
    // Region metadata for tooltips
    const regionMetadata = ${JSON.stringify(
      Object.fromEntries(
        regionNames.map((region) => [
          region,
          {
            region,
            stats: stats.byRegion[region],
            sandboxCount: sandboxes.filter((s) => s.region === region).length,
          },
        ]),
      ),
      null,
      2,
    )};

    // Latency by Region Chart with enhanced tooltips
    new Chart(document.getElementById('latencyRegionChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(latencyByRegion.map((r) => r.region))},
        datasets: [{
          label: 'Mean (ms)',
          data: ${JSON.stringify(latencyByRegion.map((r) => r.mean))},
          backgroundColor: ${JSON.stringify(latencyByRegion.map((r) => (r.region.startsWith("eu") ? "rgba(21, 101, 192, 0.7)" : "rgba(239, 108, 0, 0.7)")))},
        }, {
          label: 'P95 (ms)',
          data: ${JSON.stringify(latencyByRegion.map((r) => r.p95))},
          backgroundColor: ${JSON.stringify(latencyByRegion.map((r) => (r.region.startsWith("eu") ? "rgba(21, 101, 192, 0.3)" : "rgba(239, 108, 0, 0.3)")))},
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            backgroundColor: 'rgba(30, 30, 30, 0.95)',
            borderColor: '#1565c0',
            borderWidth: 1,
            padding: 12,
            callbacks: {
              title: function(tooltipItems) {
                return 'Region: ' + tooltipItems[0].label;
              },
              beforeBody: function(tooltipItems) {
                const region = tooltipItems[0].label;
                const meta = regionMetadata[region];
                if (!meta) return '';
                return 'Sandboxes tested: ' + meta.sandboxCount;
              },
              label: function(context) {
                return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + ' ms';
              },
              afterBody: function(tooltipItems) {
                const region = tooltipItems[0].label;
                const meta = regionMetadata[region];
                if (!meta || !meta.stats) return '';
                const stats = meta.stats.requestLatency;
                return [
                  '',
                  '── Full Stats ──',
                  'Min: ' + stats.min.toFixed(0) + ' ms',
                  'Max: ' + stats.max.toFixed(0) + ' ms',
                  'Median: ' + stats.median.toFixed(0) + ' ms',
                  'P99: ' + stats.p99.toFixed(0) + ' ms',
                  'Std Dev: ' + stats.stdDev.toFixed(1) + ' ms'
                ].join('\\n');
              }
            }
          }
        },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Time (ms)' } } }
      }
    });
    `
        : ""
    }
  </script>

  <footer style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px;">
    Generated by Sandbox Benchmark Suite • ${new Date().toISOString()}
  </footer>
</body>
</html>`;
}

function generateConfigSection(configJson: string): string {
  try {
    const config = JSON.parse(configJson) as {
      configs?: Array<{
        name: string;
        provider: string;
        image?: { provider: string; identifier: string; dockerfile: string; builtAt: string };
        region?: string;
        cpu?: number;
        memoryMb?: number;
      }>;
      machinesPerConfig?: number;
      requestsPerMachine?: number;
      batchSize?: number;
      restartCyclesPerMachine?: number;
      measurements?: { coldBoot?: boolean; restart?: boolean; requestLatency?: boolean };
      output?: string;
    };

    const configsHtml =
      config.configs
        ?.map(
          (c) => `
      <tr>
        <td>${c.name}</td>
        <td>${c.provider}</td>
        <td>${c.image?.identifier ?? "-"}</td>
        <td>${c.image?.dockerfile ?? "-"}</td>
        <td>${c.region ?? "-"}</td>
        <td>${c.cpu ?? "-"}</td>
        <td>${c.memoryMb ?? "-"}</td>
      </tr>
    `,
        )
        .join("") ?? "";

    const measurementsEnabled = config.measurements
      ? Object.entries(config.measurements)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ")
      : "-";

    return `
  <h2>⚙️ Benchmark Configuration</h2>
  <div class="card">
    <h3>Run Parameters</h3>
    <table class="config-table">
      <tr><td>Machines per Config</td><td>${config.machinesPerConfig ?? "-"}</td></tr>
      <tr><td>Requests per Machine</td><td>${config.requestsPerMachine ?? "-"}</td></tr>
      <tr><td>Batch Size</td><td>${config.batchSize ?? "-"}</td></tr>
      <tr><td>Restart Cycles</td><td>${config.restartCyclesPerMachine ?? "-"}</td></tr>
      <tr><td>Measurements</td><td>${measurementsEnabled}</td></tr>
      <tr><td>Output File</td><td>${config.output ?? "-"}</td></tr>
    </table>
  </div>

  <div class="card">
    <h3>Provider Configurations</h3>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Provider</th>
          <th>Snapshot/Image ID</th>
          <th>Dockerfile</th>
          <th>Region</th>
          <th>CPU</th>
          <th>Memory (MB)</th>
        </tr>
      </thead>
      <tbody>
        ${configsHtml}
      </tbody>
    </table>
  </div>

  <div class="card">
    <details>
      <summary>Full Configuration JSON</summary>
      <div class="config-json">${escapeHtml(configJson)}</div>
    </details>
  </div>
`;
  } catch {
    return `
  <h2>⚙️ Benchmark Configuration</h2>
  <div class="card">
    <details>
      <summary>Configuration JSON</summary>
      <div class="config-json">${escapeHtml(configJson)}</div>
    </details>
  </div>
`;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function createHistogramBuckets(
  values: number[],
  bucketCount: number,
): { labels: string[]; counts: number[] } {
  if (values.length === 0) {
    return { labels: [], counts: [] };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const bucketSize = Math.ceil((max - min) / bucketCount) || 1;

  const labels: string[] = [];
  const counts: number[] = new Array(bucketCount).fill(0);

  for (let i = 0; i < bucketCount; i++) {
    const start = min + i * bucketSize;
    const end = start + bucketSize;
    labels.push(`${start.toFixed(0)}-${end.toFixed(0)}`);
  }

  for (const value of values) {
    const bucketIndex = Math.min(Math.floor((value - min) / bucketSize), bucketCount - 1);
    counts[bucketIndex]++;
  }

  return { labels, counts };
}

export async function generateReport(
  dbPath: string,
  outputPath: string,
  runId?: string,
): Promise<void> {
  console.log(`[report] Loading data from ${dbPath}...`);
  const data = loadReportData(dbPath, runId);

  console.log(`[report] Generating HTML report...`);
  const html = generateHtmlReport(data);

  const absoluteOutput = resolve(process.cwd(), outputPath);
  writeFileSync(absoluteOutput, html);

  console.log(`[report] Report written to ${absoluteOutput}`);
}

// CLI entry point
if (process.argv[1].endsWith("report.ts") || process.argv[1].endsWith("report.js")) {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  const outputPath = args[1] || "benchmark-report.html";

  if (!dbPath) {
    console.error("Usage: tsx report.ts <database.db> [output.html]");
    process.exit(1);
  }

  generateReport(dbPath, outputPath).catch((error) => {
    console.error("[report] Error:", error);
    process.exit(1);
  });
}
