import { spawn } from "node:child_process";

type RunSummary = {
  appendP50Ms: number | null;
  appendP90Ms: number | null;
  appendP99Ms: number | null;
  benchmarkId: string | null;
  derivedWaitMs: number | null;
  errorMessage?: string;
  finalSubscriberWaitMs: number | null;
  processorWaitMs: number | null;
  publishDurationMs: number | null;
  sourceSubscriberWaitMs: number | null;
  status: "fulfilled" | "rejected";
  traffic: string | null;
};

type Options = {
  delayMs: number;
  passThroughArgs: string[];
  repeat: number;
};

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const runs: RunSummary[] = [];

  for (let index = 0; index < options.repeat; index += 1) {
    if (index > 0 && options.delayMs > 0) {
      await delay(options.delayMs);
    }

    runs.push(await runOne(options.passThroughArgs));
  }

  const output = {
    options: {
      delayMs: options.delayMs,
      passThroughArgs: options.passThroughArgs,
      repeat: options.repeat,
    },
    runs,
    summary: summarizeRuns(runs),
  };
  console.log(JSON.stringify(output, null, 2));

  if (runs.some((run) => run.status === "rejected")) {
    process.exitCode = 1;
  }
}

function parseOptions(args: readonly string[]): Options {
  const passThroughArgs: string[] = [];
  let repeat = 5;
  let delayMs = 1000;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) continue;
    if (arg === "--") continue;

    if (arg === "--repeat") {
      repeat = parsePositiveInt(args[index + 1], "--repeat");
      index += 1;
      continue;
    }
    if (arg.startsWith("--repeat=")) {
      repeat = parsePositiveInt(arg.slice("--repeat=".length), "--repeat");
      continue;
    }
    if (arg === "--delay-ms") {
      delayMs = parseNonNegativeInt(args[index + 1], "--delay-ms");
      index += 1;
      continue;
    }
    if (arg.startsWith("--delay-ms=")) {
      delayMs = parseNonNegativeInt(arg.slice("--delay-ms=".length), "--delay-ms");
      continue;
    }

    passThroughArgs.push(arg);
  }

  return { delayMs, passThroughArgs, repeat };
}

function parsePositiveInt(value: string | undefined, option: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, option: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer.`);
  }
  return parsed;
}

async function runOne(args: string[]): Promise<RunSummary> {
  const result = await spawnCapture("pnpm", [
    "exec",
    "tsx",
    "./scripts/benchmark-agent-stream-server.ts",
    "--",
    ...args,
  ]);

  if (result.exitCode !== 0) {
    return {
      appendP50Ms: null,
      appendP90Ms: null,
      appendP99Ms: null,
      benchmarkId: null,
      derivedWaitMs: null,
      errorMessage: result.stderr || result.stdout || `exit ${result.exitCode}`,
      finalSubscriberWaitMs: null,
      processorWaitMs: null,
      publishDurationMs: null,
      sourceSubscriberWaitMs: null,
      status: "rejected",
      traffic: null,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    const benchmark = parsed.result;
    return {
      appendP50Ms: benchmark.appendLatencyMs?.p50 ?? null,
      appendP90Ms: benchmark.appendLatencyMs?.p90 ?? null,
      appendP99Ms: benchmark.appendLatencyMs?.p99 ?? null,
      benchmarkId: benchmark.benchmarkId ?? null,
      derivedWaitMs: waitMs(benchmark.derivedEventWait),
      finalSubscriberWaitMs: waitMs(benchmark.finalSubscriberWait),
      processorWaitMs: waitMs(benchmark.processorWait),
      publishDurationMs: benchmark.publishDurationMs ?? null,
      sourceSubscriberWaitMs: waitMs(benchmark.sourceSubscriberWait),
      status: "fulfilled",
      traffic: benchmark.traffic?.traffic ?? null,
    };
  } catch (error) {
    return {
      appendP50Ms: null,
      appendP90Ms: null,
      appendP99Ms: null,
      benchmarkId: null,
      derivedWaitMs: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      finalSubscriberWaitMs: null,
      processorWaitMs: null,
      publishDurationMs: null,
      sourceSubscriberWaitMs: null,
      status: "rejected",
      traffic: null,
    };
  }
}

function waitMs(value: unknown) {
  if (value == null || typeof value !== "object") return null;
  const wait = (value as { waitMs?: unknown }).waitMs;
  return typeof wait === "number" ? wait : null;
}

function spawnCapture(command: string, args: string[]) {
  return new Promise<{ exitCode: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

function summarizeRuns(runs: RunSummary[]) {
  return {
    appendP50Ms: summarizeMetric(runs, "appendP50Ms"),
    appendP90Ms: summarizeMetric(runs, "appendP90Ms"),
    appendP99Ms: summarizeMetric(runs, "appendP99Ms"),
    derivedWaitMs: summarizeMetric(runs, "derivedWaitMs"),
    failureCount: runs.filter((run) => run.status === "rejected").length,
    finalSubscriberWaitMs: summarizeMetric(runs, "finalSubscriberWaitMs"),
    fulfilledCount: runs.filter((run) => run.status === "fulfilled").length,
    processorWaitMs: summarizeMetric(runs, "processorWaitMs"),
    publishDurationMs: summarizeMetric(runs, "publishDurationMs"),
    sourceSubscriberWaitMs: summarizeMetric(runs, "sourceSubscriberWaitMs"),
  };
}

function summarizeMetric(runs: RunSummary[], key: keyof RunSummary) {
  const values = runs
    .map((run) => run[key])
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right);
  if (values.length === 0) return null;
  return {
    count: values.length,
    max: values.at(-1)!,
    mean: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
    min: values[0]!,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  };
}

function percentile(values: number[], percentileValue: number) {
  const index = Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1);
  return values[index]!;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
