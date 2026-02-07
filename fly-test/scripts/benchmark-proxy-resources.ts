#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findFlyDir, nowTag, runCommand } from "../e2e/run-observability-lib.ts";
import type { CommandResult } from "../e2e/run-observability-lib.ts";

type BenchmarkPhase = "warmup" | "proxied" | "direct" | "idle";

type DockerStatRaw = {
  BlockIO: string;
  CPUPerc: string;
  Container: string;
  ID: string;
  MemPerc: string;
  MemUsage: string;
  Name: string;
  NetIO: string;
  PIDs: string;
};

type DockerStatSample = {
  at: string;
  phase: BenchmarkPhase;
  containerId: string;
  containerName: string;
  cpuPercent: number | null;
  memPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  raw: DockerStatRaw;
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
  const parts = raw.split("/").map((value) => value.trim());
  if (parts.length !== 2) return { usedBytes: null, limitBytes: null };
  return {
    usedBytes: parseBytes(parts[0]),
    limitBytes: parseBytes(parts[1]),
  };
}

function summarize(values: number[]): PhaseSummary {
  if (values.length === 0) {
    return {
      requests: 0,
      minSeconds: 0,
      maxSeconds: 0,
      avgSeconds: 0,
      p50Seconds: 0,
    };
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

async function runCommandAsync(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function parseDurations(raw: string): number[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number.parseFloat(line))
    .filter((value) => Number.isFinite(value));
}

async function main(): Promise<void> {
  const flyDir = findFlyDir();
  const composeFile = join(flyDir, "docker-compose.local.yml");
  const composeProject = process.env["BENCH_COMPOSE_PROJECT"] ?? "proxylat";
  const cleanupStack = process.env["BENCH_CLEANUP_STACK"] !== "0";
  const targetUrl = process.env["TARGET_URL"] ?? "https://example.com/";
  const requests = Number.parseInt(process.env["BENCH_REQUESTS"] ?? "30", 10);
  const sampleMs = Number.parseInt(process.env["BENCH_SAMPLE_MS"] ?? "500", 10);
  if (!Number.isFinite(requests) || requests <= 0) throw new Error("BENCH_REQUESTS must be > 0");
  if (!Number.isFinite(sampleMs) || sampleMs <= 0) throw new Error("BENCH_SAMPLE_MS must be > 0");

  const outDir = join(flyDir, "proof-logs", "benchmarks");
  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, `${nowTag()}-proxy-resource-bench.json`);

  process.stdout.write(`starting stack: project=${composeProject}\n`);
  runCommand("docker", ["compose", "-f", composeFile, "-p", composeProject, "up", "-d", "--build"]);

  const idsOutput = runCommand("docker", [
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
  const containerIds = idsOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (containerIds.length === 0) throw new Error("no running containers found");

  let phase: BenchmarkPhase = "warmup";
  const statsSamples: DockerStatSample[] = [];
  let statsStderr = "";
  const pushStatLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let raw: DockerStatRaw;
    try {
      raw = JSON.parse(trimmed) as DockerStatRaw;
    } catch {
      return;
    }
    const mem = parseMemUsage(raw.MemUsage);
    statsSamples.push({
      at: new Date().toISOString(),
      phase,
      containerId: raw.ID,
      containerName: raw.Name,
      cpuPercent: parsePercent(raw.CPUPerc),
      memPercent: parsePercent(raw.MemPerc),
      memUsedBytes: mem.usedBytes,
      memLimitBytes: mem.limitBytes,
      raw,
    });
  };
  const sampleNoStreamOnce = async (): Promise<void> => {
    const result = await runCommandAsync("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      ...containerIds,
    ]);
    if (result.status !== 0) return;
    for (const line of result.stdout.split(/\r?\n/)) {
      pushStatLine(line);
    }
  };

  const statsProc = spawn("docker", ["stats", "--format", "{{json .}}", ...containerIds], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  statsProc.stderr.on("data", (chunk: Buffer) => {
    statsStderr += chunk.toString("utf8");
  });
  let statsBuffer = "";
  statsProc.stdout.on("data", (chunk: Buffer) => {
    statsBuffer += chunk.toString("utf8").replaceAll("\r", "\n");
    while (true) {
      const newLine = statsBuffer.indexOf("\n");
      if (newLine < 0) break;
      const line = statsBuffer.slice(0, newLine);
      statsBuffer = statsBuffer.slice(newLine + 1);
      pushStatLine(line);
    }
  });
  const quotedTargetUrl = shellSingleQuote(targetUrl);
  const runPhase = async (
    phaseName: "proxied" | "direct",
    requestFlag: string,
  ): Promise<number[]> => {
    phase = phaseName;
    process.stdout.write(`benchmark phase=${phaseName} requests=${requests}\n`);
    const shellCommand = [
      "set -e",
      `for i in $(seq 1 ${requests}); do`,
      `  curl -sS --max-time 20 -o /dev/null -w '%{time_total}\\n' ${requestFlag} ${quotedTargetUrl}`,
      "done",
    ].join("\n");
    const result = await runCommandAsync("docker", [
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
      shellCommand,
    ]);
    if (result.status !== 0) {
      throw new Error(
        [
          `benchmark failed in phase=${phaseName}`,
          `status=${result.status}`,
          result.stdout.length > 0 ? `stdout:\n${result.stdout}` : "",
          result.stderr.length > 0 ? `stderr:\n${result.stderr}` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
    }
    return parseDurations(result.stdout);
  };

  try {
    await sampleNoStreamOnce();
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
    await sampleNoStreamOnce();
    const proxied = await runPhase("proxied", "-x http://egress-proxy:18080");
    await sampleNoStreamOnce();
    const direct = await runPhase("direct", "--noproxy '*'");
    phase = "idle";
    await sampleNoStreamOnce();
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
    statsProc.kill("SIGKILL");
    if (statsStderr.trim().length > 0) {
      throw new Error(`docker stats stderr: ${statsStderr.trim()}`);
    }

    const proxiedSummary = summarize(proxied);
    const directSummary = summarize(direct);

    const report = {
      generatedAt: new Date().toISOString(),
      composeProject,
      composeFile,
      targetUrl,
      requests,
      sampleIntervalMs: sampleMs,
      benchmark: {
        proxiedSeconds: proxied,
        directSeconds: direct,
        proxiedSummary,
        directSummary,
        averageDeltaSeconds: proxiedSummary.avgSeconds - directSummary.avgSeconds,
        p50DeltaSeconds: proxiedSummary.p50Seconds - directSummary.p50Seconds,
      },
      resources: statsSamples,
    };

    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`benchmark report: ${outputPath}\n`);
  } finally {
    if (!statsProc.killed) statsProc.kill("SIGKILL");
    if (cleanupStack) {
      runCommand("docker", ["compose", "-f", composeFile, "-p", composeProject, "down", "-v"], {
        allowFailure: true,
      });
    }
  }
}

await main();
