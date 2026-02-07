#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findFlyDir, nowTag, runCommand } from "../e2e/run-observability-lib.ts";

type BenchmarkPhase = "warmup" | "proxied" | "direct" | "idle";

type DockerStatsRow = {
  ID: string;
  Name: string;
  CPUPerc: string;
  MemPerc: string;
  MemUsage: string;
};

type ResourceSample = {
  at: string;
  phase: BenchmarkPhase;
  containerId: string;
  containerName: string;
  cpuPercent: number | null;
  memPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
};

type PhaseSummary = {
  requests: number;
  minSeconds: number;
  maxSeconds: number;
  avgSeconds: number;
  p50Seconds: number;
};

function parsePercent(raw: string): number | null {
  const value = Number.parseFloat(raw.replace("%", "").trim());
  return Number.isFinite(value) ? value : null;
}

function parseBytes(raw: string): number | null {
  const value = raw.trim();
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?i?B)$/);
  if (!match) return null;
  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric)) return null;
  const unit = match[2];
  const factors: Record<string, number> = {
    B: 1,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
    PiB: 1024 ** 5,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    PB: 1000 ** 5,
  };
  const factor = factors[unit];
  if (!factor) return null;
  return Math.round(numeric * factor);
}

function parseMemUsage(raw: string): { usedBytes: number | null; limitBytes: number | null } {
  const [used, limit] = raw.split("/").map((value) => value.trim());
  if (!used || !limit) return { usedBytes: null, limitBytes: null };
  return { usedBytes: parseBytes(used), limitBytes: parseBytes(limit) };
}

function summarize(values: number[]): PhaseSummary {
  if (values.length === 0) {
    return { requests: 0, minSeconds: 0, maxSeconds: 0, avgSeconds: 0, p50Seconds: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, value) => acc + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    requests: values.length,
    minSeconds: sorted[0],
    maxSeconds: sorted[sorted.length - 1],
    avgSeconds: sum / values.length,
    p50Seconds: p50,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function getContainerIds(composeFile: string, composeProject: string): string[] {
  const output = runCommand("docker", [
    "compose",
    "-f",
    composeFile,
    "-p",
    composeProject,
    "ps",
    "-q",
    "egress-proxy",
    "sandbox-ui",
  ]).stdout;
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function sampleResources(
  composeFile: string,
  composeProject: string,
  containerIds: string[],
  phase: BenchmarkPhase,
  samples: ResourceSample[],
): void {
  const result = runCommand(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}", ...containerIds],
    { allowFailure: true },
  );
  if (result.status !== 0) return;
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: DockerStatsRow;
    try {
      row = JSON.parse(trimmed) as DockerStatsRow;
    } catch {
      continue;
    }
    const mem = parseMemUsage(row.MemUsage);
    samples.push({
      at: new Date().toISOString(),
      phase,
      containerId: row.ID,
      containerName: row.Name,
      cpuPercent: parsePercent(row.CPUPerc),
      memPercent: parsePercent(row.MemPerc),
      memUsedBytes: mem.usedBytes,
      memLimitBytes: mem.limitBytes,
    });
  }
}

function runRequest(
  composeFile: string,
  composeProject: string,
  requestFlag: string,
  targetUrl: string,
): number {
  const command = `curl -sS --max-time 20 -o /dev/null -w '%{time_total}' ${requestFlag} ${shellSingleQuote(targetUrl)}`;
  const result = runCommand("docker", [
    "compose",
    "-f",
    composeFile,
    "-p",
    composeProject,
    "exec",
    "-T",
    "sandbox-ui",
    "sh",
    "-lc",
    command,
  ]);
  const value = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`failed to parse curl timing: ${result.stdout}`);
  }
  return value;
}

function runPhase(
  composeFile: string,
  composeProject: string,
  containerIds: string[],
  targetUrl: string,
  requests: number,
  phase: "proxied" | "direct",
  requestFlag: string,
  samples: ResourceSample[],
): number[] {
  process.stdout.write(`benchmark phase=${phase} requests=${requests}\n`);
  const durations: number[] = [];
  for (let i = 0; i < requests; i += 1) {
    durations.push(runRequest(composeFile, composeProject, requestFlag, targetUrl));
    sampleResources(composeFile, composeProject, containerIds, phase, samples);
  }
  return durations;
}

async function main(): Promise<void> {
  const flyDir = findFlyDir();
  const composeFile = join(flyDir, "docker-compose.local.yml");
  const composeProject = process.env["BENCH_COMPOSE_PROJECT"] ?? "proxylat";
  const cleanupStack = process.env["BENCH_CLEANUP_STACK"] !== "0";
  const targetUrl = process.env["TARGET_URL"] ?? "https://example.com/";
  const requests = Number.parseInt(process.env["BENCH_REQUESTS"] ?? "30", 10);
  if (!Number.isFinite(requests) || requests <= 0) throw new Error("BENCH_REQUESTS must be > 0");

  const outDir = join(flyDir, "proof-logs", "benchmarks");
  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, `${nowTag()}-proxy-resource-bench.json`);

  process.stdout.write(`starting stack: project=${composeProject}\n`);
  runCommand("docker", ["compose", "-f", composeFile, "-p", composeProject, "up", "-d", "--build"]);

  const containerIds = getContainerIds(composeFile, composeProject);
  if (containerIds.length === 0) throw new Error("no running containers found");

  const samples: ResourceSample[] = [];
  try {
    sampleResources(composeFile, composeProject, containerIds, "warmup", samples);
    const proxied = runPhase(
      composeFile,
      composeProject,
      containerIds,
      targetUrl,
      requests,
      "proxied",
      "-x http://egress-proxy:18080",
      samples,
    );
    const direct = runPhase(
      composeFile,
      composeProject,
      containerIds,
      targetUrl,
      requests,
      "direct",
      "--noproxy '*'",
      samples,
    );
    sampleResources(composeFile, composeProject, containerIds, "idle", samples);

    const proxiedSummary = summarize(proxied);
    const directSummary = summarize(direct);
    const report = {
      generatedAt: new Date().toISOString(),
      composeProject,
      composeFile,
      targetUrl,
      requests,
      benchmark: {
        proxiedSeconds: proxied,
        directSeconds: direct,
        proxiedSummary,
        directSummary,
        averageDeltaSeconds: proxiedSummary.avgSeconds - directSummary.avgSeconds,
        p50DeltaSeconds: proxiedSummary.p50Seconds - directSummary.p50Seconds,
      },
      resources: samples,
    };
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`benchmark report: ${outputPath}\n`);
  } finally {
    if (cleanupStack) {
      runCommand("docker", ["compose", "-f", composeFile, "-p", composeProject, "down"], {
        allowFailure: true,
      });
    }
  }
}

await main();
