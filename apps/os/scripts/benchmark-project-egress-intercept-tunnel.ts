import { createCaptunTunnel } from "captun/client";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { osContract } from "@iterate-com/os-contract";
import { projectEgressInterceptUrlFor } from "../e2e/test-support/project-egress-intercept-tunnel.ts";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;

type Options = {
  baseUrl: string;
  concurrency: number;
  iterations: number;
  json: boolean;
  pauseMs: number;
  projectSlugOrId: string;
  verbose: boolean;
  warmup: number;
};

type TunnelResult = {
  connectMs: number;
  disposeMs: number;
  error: string | null;
};

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const client = createClient(options.baseUrl);

  const project = await client.project.get({
    projectSlugOrId: options.projectSlugOrId,
  });

  const interceptUrl = projectEgressInterceptUrlFor({
    baseUrl: options.baseUrl,
    project,
  });

  const meta = {
    baseUrl: options.baseUrl,
    interceptUrl: interceptUrl.hostname,
    iterations: options.iterations,
    nodeVersion: process.version,
    projectId: project.id,
    projectSlug: project.slug,
    timestamp: new Date().toISOString(),
    warmup: options.warmup,
  };

  if (!options.json) {
    console.log(`Benchmarking tunnel to ${interceptUrl.hostname}`);
    console.log(`Project: ${project.slug} (${project.id})`);
    console.log(
      `Warmup: ${options.warmup}, Iterations: ${options.iterations}, Concurrency: ${options.concurrency}`,
    );
    console.log();
  }

  // Warmup
  if (options.warmup > 0) {
    if (!options.json) console.log(`Warming up (${options.warmup} iterations)...`);
    for (let i = 0; i < options.warmup; i++) {
      await runOneTunnel({ interceptUrl, options });
      if (options.pauseMs > 0) await delay(options.pauseMs);
    }
    if (!options.json) console.log();
  }

  // Benchmark
  const results: TunnelResult[] = [];
  const failures: string[] = [];

  if (options.concurrency <= 1) {
    for (let i = 0; i < options.iterations; i++) {
      const result = await runOneTunnel({ interceptUrl, options });
      results.push(result);
      if (result.error) failures.push(result.error);
      if (options.verbose && !options.json) {
        console.log(
          `  [${i + 1}] connect=${round(result.connectMs)}ms dispose=${round(result.disposeMs)}ms${result.error ? ` ERROR: ${result.error}` : ""}`,
        );
      }
      if (options.pauseMs > 0 && i < options.iterations - 1) await delay(options.pauseMs);
    }
  } else {
    let completed = 0;
    const inFlight = new Set<Promise<void>>();
    for (let i = 0; i < options.iterations; i++) {
      const promise = (async () => {
        const result = await runOneTunnel({ interceptUrl, options });
        results.push(result);
        if (result.error) failures.push(result.error);
        completed++;
        if (options.verbose && !options.json) {
          console.log(
            `  [${completed}] connect=${round(result.connectMs)}ms dispose=${round(result.disposeMs)}ms${result.error ? ` ERROR: ${result.error}` : ""}`,
          );
        }
      })().finally(() => inFlight.delete(promise));
      inFlight.add(promise);
      if (inFlight.size >= options.concurrency) await Promise.race(inFlight);
    }
    while (inFlight.size > 0) await Promise.race(inFlight);
  }

  const successful = results.filter((r) => !r.error);
  const failureGroups = groupBy(failures, (msg) => msg);

  const report = {
    meta,
    options: {
      concurrency: options.concurrency,
      iterations: options.iterations,
      pauseMs: options.pauseMs,
      warmup: options.warmup,
    },
    connectMs: summarize(successful.map((r) => r.connectMs)),
    disposeMs: summarize(successful.map((r) => r.disposeMs)),
    totalMs: summarize(successful.map((r) => r.connectMs + r.disposeMs)),
    failures: {
      count: failures.length,
      groups: Object.fromEntries(failureGroups),
    },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log();
    console.log(`Results (${successful.length} successful, ${failures.length} failed):`);
    console.log();
    printSummary("connect", report.connectMs);
    printSummary("dispose", report.disposeMs);
    printSummary("total  ", report.totalMs);
    if (failures.length > 0) {
      console.log();
      console.log("Failures:");
      for (const [message, count] of failureGroups) {
        console.log(`  ${count}x ${message}`);
      }
    }
  }
}

async function runOneTunnel(input: { interceptUrl: URL; options: Options }): Promise<TunnelResult> {
  const adminToken = requireAdminBearerToken();
  const connectStart = performance.now();
  let tunnel: Disposable;
  try {
    tunnel = await createCaptunTunnel({
      url: input.interceptUrl,
      headers: { Authorization: `Bearer ${adminToken}` },
      fetch: globalThis.fetch,
    });
  } catch (error) {
    return {
      connectMs: performance.now() - connectStart,
      disposeMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const connectMs = performance.now() - connectStart;

  const disposeStart = performance.now();
  tunnel[Symbol.dispose]();
  const disposeMs = performance.now() - disposeStart;

  return { connectMs, disposeMs, error: null };
}

function printSummary(label: string, stats: ReturnType<typeof summarize>) {
  if (!stats) return;
  console.log(
    `  ${label}: min=${stats.min}ms p50=${stats.p50}ms p75=${stats.p75}ms p90=${stats.p90}ms p95=${stats.p95}ms p99=${stats.p99}ms max=${stats.max}ms mean=${stats.mean}ms (n=${stats.count})`,
  );
}

function summarize(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    max: round(sorted.at(-1) ?? 0),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    p90: round(percentile(sorted, 0.9)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
  };
}

function percentile(sorted: readonly number[], point: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * point) - 1));
  return sorted[index] ?? 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function groupBy(items: readonly string[], keyFn: (item: string) => string) {
  const groups = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups;
}

function createClient(baseUrl: string) {
  const adminToken = requireAdminBearerToken();
  return createORPCClient(
    new OpenAPILink(osContract, {
      url: `${baseUrl}/api`,
      fetch: (input, init) => {
        const requestInit: RequestInit = init ?? {};
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        for (const [key, value] of new Headers(requestInit.headers)) headers.set(key, value);
        headers.set("Authorization", `Bearer ${adminToken}`);
        if (input instanceof Request) return fetch(new Request(input, { ...requestInit, headers }));
        return fetch(input, { ...requestInit, headers });
      },
    }),
  ) as OrpcClient;
}

function requireAdminBearerToken() {
  const token =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error(
      "OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, or APP_CONFIG_ADMIN_API_SECRET is required.",
    );
  }
  return token;
}

function parseOptions(args: readonly string[]): Options {
  const values = parseArgs(args);

  if (values.has("help")) {
    console.log(`Usage: tsx benchmark-project-egress-intercept-tunnel.ts --project-slug-or-id <slug>

Options:
  --project-slug-or-id  Project slug or ID (required)
  --base-url            OS base URL (default: OS_BASE_URL or APP_CONFIG_BASE_URL)
  --iterations          Number of benchmark iterations (default: 50)
  --concurrency         Concurrent tunnel connections (default: 1)
  --warmup              Warmup iterations (default: 3)
  --pause-ms            Pause between sequential iterations (default: 100)
  --json                Machine-readable JSON output
  --verbose             Show per-iteration durations
  --help                Show this help`);
    process.exit(0);
  }

  return {
    baseUrl: stringOption(
      values,
      "base-url",
      process.env.OS_BASE_URL ?? process.env.APP_CONFIG_BASE_URL ?? "",
    ),
    concurrency: numberOption(values, "concurrency", 1),
    iterations: numberOption(values, "iterations", 50),
    json: booleanOption(values, "json", false),
    pauseMs: numberOption(values, "pause-ms", 100),
    projectSlugOrId: stringOption(values, "project-slug-or-id", ""),
    verbose: booleanOption(values, "verbose", false),
    warmup: numberOption(values, "warmup", 3),
  };
}

function parseArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey ?? "";
    if (!key) throw new Error(`Invalid option: ${arg}`);
    if (inlineValue != null) {
      values.set(key, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next == null || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }
  return values;
}

function stringOption(values: Map<string, string>, key: string, fallback: string) {
  const value = values.get(key) ?? fallback;
  if (!value.trim()) throw new Error(`--${key} is required.`);
  return value.trim();
}

function numberOption(values: Map<string, string>, key: string, fallback: number) {
  const raw = values.get(key) ?? String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative number.`);
  }
  return value;
}

function booleanOption(values: Map<string, string>, key: string, fallback: boolean) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw new Error(`--${key} must be true or false.`);
}

async function delay(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
