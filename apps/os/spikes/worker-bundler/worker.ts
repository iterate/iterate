import { createApp, type CreateAppResult } from "@cloudflare/worker-bundler";

interface Env {
  LOADER: WorkerLoader;
}

interface Probe {
  body?: string;
  expectedBodyIncludes?: string[];
  expectedStatus: number;
  headers?: Record<string, string>;
  method?: string;
  path: string;
}

interface BenchmarkInput {
  files: Record<string, string>;
  name: string;
  probes: Probe[];
  warmIterations: number;
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function moduleBytes(result: CreateAppResult): number {
  return Object.values(result.modules).reduce((total, module) => {
    if (typeof module === "string") return total + module.length;
    if (typeof module.js === "string") return total + module.js.length;
    if (typeof module.cjs === "string") return total + module.cjs.length;
    if (typeof module.text === "string") return total + module.text.length;
    if (module.data instanceof ArrayBuffer) return total + module.data.byteLength;
    return total;
  }, 0);
}

function parseInput(value: unknown): BenchmarkInput {
  if (typeof value !== "object" || value === null) {
    throw new Error("Benchmark request must be a JSON object.");
  }
  const input = value as Partial<BenchmarkInput>;
  if (
    typeof input.name !== "string" ||
    typeof input.files !== "object" ||
    input.files === null ||
    !Array.isArray(input.probes) ||
    !Number.isInteger(input.warmIterations) ||
    (input.warmIterations ?? -1) < 1
  ) {
    throw new Error("Benchmark request is missing name, files, probes, or warmIterations.");
  }
  return input as BenchmarkInput;
}

interface BuildResult {
  bundleBytes: number;
  durationMs: number;
  output: CreateAppResult;
}

async function build(files: Record<string, string>): Promise<BuildResult> {
  const startedAt = performance.now();
  const output = await createApp({ files });
  const warnings = output.warnings ?? [];
  if (warnings.length > 0) {
    throw new Error(`worker-bundler returned warnings:\n${warnings.join("\n")}`);
  }
  return { bundleBytes: moduleBytes(output), durationMs: elapsedMs(startedAt), output };
}

async function checkProbes(
  input: BenchmarkInput,
  output: CreateAppResult,
  env: Env,
): Promise<void> {
  const worker = env.LOADER.get(`worker-bundler-spike-${crypto.randomUUID()}`, () => ({
    compatibilityDate: "2026-07-08",
    mainModule: output.mainModule,
    modules: output.modules,
  }));
  const entrypoint = worker.getEntrypoint();

  for (const probe of input.probes) {
    const response = await entrypoint.fetch(
      new Request(`http://app.test${probe.path}`, {
        ...(probe.body === undefined ? {} : { body: probe.body }),
        headers: probe.headers,
        method: probe.method ?? "GET",
        redirect: "manual",
      }),
    );
    const body = await response.text();
    if (response.status !== probe.expectedStatus) {
      throw new Error(
        `${input.name} ${probe.method ?? "GET"} ${probe.path} returned ${response.status}; expected ${probe.expectedStatus}. Body: ${body.slice(0, 500)}`,
      );
    }
    for (const expected of probe.expectedBodyIncludes ?? []) {
      if (!body.includes(expected)) {
        throw new Error(
          `${input.name} ${probe.method ?? "GET"} ${probe.path} did not include ${JSON.stringify(expected)}. Body: ${body.slice(0, 500)}`,
        );
      }
    }
  }
}

async function benchmark(input: BenchmarkInput, env: Env) {
  const cold = await build(input.files);
  const warmBuildMs: number[] = [];
  for (let iteration = 0; iteration < input.warmIterations; iteration += 1) {
    warmBuildMs.push((await build(input.files)).durationMs);
  }
  const executeStartedAt = performance.now();
  await checkProbes(input, cold.output, env);
  return {
    bundleBytes: cold.bundleBytes,
    coldBuildMs: cold.durationMs,
    executeMs: elapsedMs(executeStartedAt),
    name: input.name,
    requestCount: input.probes.length,
    warmBuildMs,
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (request.method !== "POST" || url.pathname !== "/benchmark") {
      return new Response("POST /benchmark", { status: 404 });
    }
    try {
      return Response.json(await benchmark(parseInput(await request.json()), env));
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
