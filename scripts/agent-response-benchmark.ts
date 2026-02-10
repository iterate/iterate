#!/usr/bin/env tsx
/**
 * Agent Response Benchmark
 *
 * Runs the agent-response-time Playwright spec N times for each machine type
 * IN PARALLEL (one worker per type), collects timing data, and generates
 * an HTML histogram report.
 *
 * Usage:
 *   tsx scripts/agent-response-benchmark.ts                          # 50 runs each, daytona + local-docker
 *   tsx scripts/agent-response-benchmark.ts --runs 10                # 10 runs each
 *   tsx scripts/agent-response-benchmark.ts --types daytona          # daytona only
 *   tsx scripts/agent-response-benchmark.ts --app-url https://stg.iterate.com
 *
 * Results are saved to test-results/benchmark-<timestamp>.json
 * HTML histogram: test-results/benchmark-<timestamp>.html
 */

import { exec } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── CLI args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1]! : fallback;
}

const RUNS = parseInt(getArg("runs", "50"), 10);
const TYPES = getArg("types", "daytona,local-docker").split(",");
const APP_URL = getArg("app-url", process.env.APP_URL ?? "");
const RESULTS_DIR = join(process.cwd(), "test-results");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");

// ── Types ──────────────────────────────────────────────────────────────

interface RunResult {
  machineType: string;
  run: number;
  machineReadyMs: number | null;
  firstResponseMs: number | null;
  secondResponseMs: number | null;
  error: string | null;
  startedAt: string;
  durationMs: number;
}

// ── Runner ─────────────────────────────────────────────────────────────

function runOnce(machineType: string, run: number): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_RESPONSE_TIME_TEST: "1",
    MACHINE_TYPE: machineType,
  };
  if (APP_URL) {
    env.APP_URL = APP_URL;
  }

  // Clean stale Playwright output to avoid trace file conflicts
  rmSync(join(process.cwd(), "test-results/output"), { recursive: true, force: true });

  return new Promise<RunResult>((resolve) => {
    const child = exec(
      "pnpm spec -- spec/agent-response-time.spec.ts --reporter=list",
      { env, timeout: 15 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // When exec fails, stdout/stderr may also live on the error object
        const errObj = error as (Error & { stdout?: string; stderr?: string }) | null;
        const allStdout = [stdout, errObj?.stdout].filter(Boolean).join("\n");
        const allStderr = [stderr, errObj?.stderr].filter(Boolean).join("\n");
        const combined = allStdout + "\n" + allStderr;

        // Extract AGENT_PERF_JSON=... from combined output
        // Accept results even if Playwright exits non-zero (e.g. trace artifact errors)
        const jsonMatch = combined.match(/AGENT_PERF_JSON=(\{.*\})/);
        if (jsonMatch) {
          const perf = JSON.parse(jsonMatch[1]!) as {
            machineReadyMs: number;
            firstResponseMs: number;
            secondResponseMs: number;
          };
          resolve({
            machineType,
            run,
            machineReadyMs: perf.machineReadyMs,
            firstResponseMs: perf.firstResponseMs,
            secondResponseMs: perf.secondResponseMs,
            error: null,
            startedAt,
            durationMs: Date.now() - start,
          });
          return;
        }

        // Failed — surface useful error info
        const allOutput = (stderr + "\n" + stdout).trim();
        const errMsg = allOutput.slice(-800) || error?.message || "No AGENT_PERF_JSON found";

        resolve({
          machineType,
          run,
          machineReadyMs: null,
          firstResponseMs: null,
          secondResponseMs: null,
          error: errMsg.slice(0, 500),
          startedAt,
          durationMs: Date.now() - start,
        });
      },
    );

    // Ensure child doesn't keep process alive on timeout
    child.unref?.();
  });
}

// ── Stats helpers ──────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  };
}

function fmt(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ── Parallel runner per machine type ───────────────────────────────────

async function runAllForType(machineType: string): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const result = await runOnce(machineType, i);
    results.push(result);

    const tag = `[${machineType}] [${i}/${RUNS}]`;
    if (result.error) {
      console.log(`${tag} ❌\n${result.error}\n`);
    } else {
      console.log(
        `${tag} ✅ boot=${fmt(result.machineReadyMs)} first=${fmt(result.firstResponseMs)} second=${fmt(result.secondResponseMs)}`,
      );
    }

    // Save incrementally so we don't lose data on crash
    writeFileSync(
      join(RESULTS_DIR, `benchmark-${TIMESTAMP}-${machineType}.json`),
      JSON.stringify(results, null, 2),
    );
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────

mkdirSync(RESULTS_DIR, { recursive: true });

const estimateMinutes = Math.round((RUNS * TYPES.length * 50) / 60);

console.log(`\n🏁 Agent Response Benchmark`);
console.log(`   Runs per type: ${RUNS}`);
console.log(`   Machine types: ${TYPES.join(", ")}`);
if (APP_URL) console.log(`   APP_URL: ${APP_URL}`);
console.log(`   Estimated time: ~${estimateMinutes} min\n`);

// Run types sequentially (Playwright's webServer can't handle concurrent instances)
const allResults: RunResult[] = [];
for (const machineType of TYPES) {
  const results = await runAllForType(machineType);
  allResults.push(...results);
}

// Save final results
writeFileSync(
  join(RESULTS_DIR, `benchmark-${TIMESTAMP}.json`),
  JSON.stringify(allResults, null, 2),
);

// ── Summary ────────────────────────────────────────────────────────────

console.log("\n\n════════════════════════════════════════");
console.log("  SUMMARY");
console.log("════════════════════════════════════════\n");

for (const machineType of TYPES) {
  const results = allResults.filter((r) => r.machineType === machineType && !r.error);
  const errors = allResults.filter((r) => r.machineType === machineType && r.error);

  const bootStats = stats(results.map((r) => r.machineReadyMs!));
  const firstStats = stats(results.map((r) => r.firstResponseMs!));
  const secondStats = stats(results.map((r) => r.secondResponseMs!));

  console.log(`  ${machineType}: ${results.length} ok, ${errors.length} failed`);
  if (bootStats) {
    console.log(
      `    Boot:   p50=${fmt(bootStats.p50)} p90=${fmt(bootStats.p90)} avg=${fmt(bootStats.avg)}`,
    );
  }
  if (firstStats) {
    console.log(
      `    First:  p50=${fmt(firstStats.p50)} p90=${fmt(firstStats.p90)} avg=${fmt(firstStats.avg)}`,
    );
  }
  if (secondStats) {
    console.log(
      `    Second: p50=${fmt(secondStats.p50)} p90=${fmt(secondStats.p90)} avg=${fmt(secondStats.avg)}`,
    );
  }
  console.log();
}

// ── Generate HTML histogram ────────────────────────────────────────────

const htmlPath = join(RESULTS_DIR, `benchmark-${TIMESTAMP}.html`);
writeFileSync(htmlPath, generateHTML(allResults, TYPES));
console.log(`📊 HTML report: ${htmlPath}`);
console.log(`📄 Raw data:    ${join(RESULTS_DIR, `benchmark-${TIMESTAMP}.json`)}\n`);

// ── HTML generator ─────────────────────────────────────────────────────

function generateHTML(results: RunResult[], types: string[]): string {
  const data = JSON.stringify(results);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Agent Response Time — ${TIMESTAMP}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem; background: #0d1117; color: #c9d1d9; }
  h1 { color: #f0f6fc; font-size: 1.5rem; margin-bottom: 0.25rem; }
  h1 span { color: #8b949e; font-weight: 400; font-size: 0.9rem; }
  .subtitle { color: #8b949e; margin-bottom: 2rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 1rem 1.25rem; }
  .card .label { color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
  .card .value { color: #f0f6fc; font-size: 1.75rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .detail { color: #8b949e; font-size: 0.8rem; margin-top: 0.25rem; }
  .chart-row { margin-bottom: 2rem; }
  .chart-row canvas { background: #161b22; border: 1px solid #21262d; border-radius: 8px; width: 100% !important; height: 300px !important; }
  .chart-full canvas { height: 350px !important; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; background: #161b22; border: 1px solid #21262d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: right; padding: 0.6rem 1rem; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  th { color: #8b949e; font-weight: 500; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; background: #0d1117; }
  th:first-child, td:first-child { text-align: left; }
  td { font-size: 0.9rem; }
  .tag { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
  .tag-daytona { background: #58a6ff22; color: #58a6ff; }
  .tag-local-docker { background: #3fb95022; color: #3fb950; }
  @media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>Agent Response Time <span>benchmark</span></h1>
<p class="subtitle">${results.length} runs across ${types.join(" & ")} · ${new Date().toISOString().split("T")[0]}</p>

<div id="cards" class="cards"></div>
<div id="table"></div>

<div class="chart-row chart-full">
  <canvas id="stripChart"></canvas>
</div>

<div class="grid2">
  <div class="chart-row"><canvas id="firstHist"></canvas></div>
  <div class="chart-row"><canvas id="secondHist"></canvas></div>
</div>

<div class="chart-row chart-full">
  <canvas id="runChart"></canvas>
</div>

<script>
const ALL = ${data};
const TYPES = ${JSON.stringify(types)};
const COLORS = { daytona: '#58a6ff', 'local-docker': '#3fb950', local: '#d2a8ff' };
const TAG_CLASS = { daytona: 'tag-daytona', 'local-docker': 'tag-local-docker', local: 'tag-local-docker' };

function pct(arr, p) {
  const s = [...arr].sort((a,b) => a - b);
  return s[Math.max(0, Math.ceil(p/100 * s.length) - 1)];
}
function fmtS(ms) { return (ms/1000).toFixed(1) + 's'; }

// ── Summary cards ──
{
  let h = '';
  for (const t of TYPES) {
    const ok = ALL.filter(r => r.machineType === t && !r.error);
    const first = ok.map(r => r.firstResponseMs).filter(Boolean);
    const second = ok.map(r => r.secondResponseMs).filter(Boolean);
    if (!first.length) continue;
    const p50f = pct(first, 50), p90f = pct(first, 90);
    const p50s = pct(second, 50);
    h += '<div class="card"><div class="label"><span class="tag ' + TAG_CLASS[t] + '">' + t + '</span> 1st response p50</div><div class="value">' + fmtS(p50f) + '</div><div class="detail">p90 ' + fmtS(p90f) + ' · n=' + first.length + '</div></div>';
    h += '<div class="card"><div class="label"><span class="tag ' + TAG_CLASS[t] + '">' + t + '</span> 2nd response p50</div><div class="value">' + fmtS(p50s) + '</div><div class="detail">p90 ' + fmtS(pct(second, 90)) + '</div></div>';
  }
  document.getElementById('cards').innerHTML = h;
}

// ── Stats table ──
{
  let h = '<table><tr><th>Provider</th><th>Metric</th><th>n</th><th>p50</th><th>p90</th><th>p99</th><th>Avg</th><th>Min</th><th>Max</th></tr>';
  for (const t of TYPES) {
    const ok = ALL.filter(r => r.machineType === t && !r.error);
    const errs = ALL.filter(r => r.machineType === t && r.error).length;
    for (const [label, key] of [['1st Response', 'firstResponseMs'], ['2nd Response', 'secondResponseMs']]) {
      const vals = ok.map(r => r[key]).filter(v => v != null).sort((a,b) => a - b);
      if (!vals.length) continue;
      const avg = Math.round(vals.reduce((a,b) => a+b, 0) / vals.length);
      h += '<tr><td><span class="tag ' + TAG_CLASS[t] + '">' + t + '</span>' + (label === '1st Response' && errs ? ' <span style="color:#f85149;font-size:0.75rem">(' + errs + ' failed)</span>' : '') + '</td>';
      h += '<td>' + label + '</td><td>' + vals.length + '</td><td>' + fmtS(pct(vals, 50)) + '</td><td>' + fmtS(pct(vals, 90)) + '</td><td>' + fmtS(pct(vals, 99)) + '</td><td>' + fmtS(avg) + '</td><td>' + fmtS(vals[0]) + '</td><td>' + fmtS(vals[vals.length-1]) + '</td></tr>';
    }
  }
  h += '</table>';
  document.getElementById('table').innerHTML = h;
}

// ── Strip / beeswarm chart (every data point, grouped) ──
{
  const datasets = [];
  let catIdx = 0;
  for (const t of TYPES) {
    const ok = ALL.filter(r => r.machineType === t && !r.error);
    // 1st response
    datasets.push({
      label: t + ' — 1st',
      data: ok.map(r => ({ x: r.firstResponseMs / 1000, y: catIdx + (Math.random() - 0.5) * 0.3 })),
      backgroundColor: COLORS[t] + 'cc',
      pointRadius: 5, pointHoverRadius: 7,
    });
    catIdx++;
    // 2nd response
    datasets.push({
      label: t + ' — 2nd',
      data: ok.map(r => ({ x: r.secondResponseMs / 1000, y: catIdx + (Math.random() - 0.5) * 0.3 })),
      backgroundColor: COLORS[t] + '66',
      borderColor: COLORS[t],
      borderWidth: 1,
      pointRadius: 5, pointHoverRadius: 7,
      pointStyle: 'triangle',
    });
    catIdx++;
  }
  const catLabels = TYPES.flatMap(t => [t + ' 1st', t + ' 2nd']);
  new Chart(document.getElementById('stripChart'), {
    type: 'scatter',
    data: { datasets },
    options: {
      indexAxis: 'x',
      plugins: {
        title: { display: true, text: 'All Response Times (each dot = one run)', color: '#f0f6fc', font: { size: 14 } },
        legend: { labels: { color: '#8b949e' } },
        tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.x.toFixed(1) + 's' } },
      },
      scales: {
        x: { title: { display: true, text: 'Seconds', color: '#8b949e' }, ticks: { color: '#8b949e' }, beginAtZero: true },
        y: { ticks: { callback: (v) => catLabels[Math.round(v)] || '', color: '#8b949e', stepSize: 1 }, min: -0.5, max: catLabels.length - 0.5, grid: { color: '#21262d' } },
      },
    },
  });
}

// ── Histograms ──
function histogram(canvasId, title, key) {
  const allVals = ALL.filter(r => !r.error && r[key] != null).map(r => r[key]);
  if (!allVals.length) return;
  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const binCount = 12;
  const binWidth = Math.max(100, (max - min) / binCount);
  const labels = Array.from({length: binCount}, (_, i) => fmtS(Math.round(min + i * binWidth)));
  const datasets = [];
  for (const t of TYPES) {
    const vals = ALL.filter(r => r.machineType === t && !r.error && r[key] != null).map(r => r[key]);
    const bins = new Array(binCount).fill(0);
    for (const v of vals) bins[Math.min(binCount - 1, Math.floor((v - min) / binWidth))]++;
    datasets.push({ label: t, data: bins, backgroundColor: COLORS[t] + '88', borderColor: COLORS[t], borderWidth: 1, borderRadius: 3 });
  }
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      plugins: { title: { display: true, text: title, color: '#f0f6fc', font: { size: 13 } }, legend: { labels: { color: '#8b949e' } } },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { ticks: { color: '#8b949e', stepSize: 1 }, beginAtZero: true, grid: { color: '#21262d' } },
      },
    },
  });
}
histogram('firstHist', '1st Response Distribution', 'firstResponseMs');
histogram('secondHist', '2nd Response Distribution', 'secondResponseMs');

// ── Run-over-time scatter ──
{
  const datasets = [];
  for (const t of TYPES) {
    const ok = ALL.filter(r => r.machineType === t && !r.error);
    datasets.push({
      label: t + ' 1st',
      data: ok.map((r, i) => ({ x: i + 1, y: r.firstResponseMs / 1000 })),
      backgroundColor: COLORS[t], borderColor: COLORS[t],
      pointRadius: 5, showLine: true, borderWidth: 1.5, tension: 0.3, fill: false,
    });
    datasets.push({
      label: t + ' 2nd',
      data: ok.map((r, i) => ({ x: i + 1, y: r.secondResponseMs / 1000 })),
      backgroundColor: COLORS[t] + '66', borderColor: COLORS[t] + '66',
      pointRadius: 4, showLine: true, borderWidth: 1, borderDash: [4, 4], tension: 0.3, fill: false,
      pointStyle: 'triangle',
    });
  }
  new Chart(document.getElementById('runChart'), {
    type: 'scatter',
    data: { datasets },
    options: {
      plugins: {
        title: { display: true, text: 'Response Time by Run (spot trends / warm-up)', color: '#f0f6fc', font: { size: 14 } },
        legend: { labels: { color: '#8b949e' } },
      },
      scales: {
        x: { title: { display: true, text: 'Run #', color: '#8b949e' }, ticks: { color: '#8b949e', stepSize: 1 } },
        y: { title: { display: true, text: 'Seconds', color: '#8b949e' }, ticks: { color: '#8b949e' }, beginAtZero: true, grid: { color: '#21262d' } },
      },
    },
  });
}
</script>
</body>
</html>`;
}
