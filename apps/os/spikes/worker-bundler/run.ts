import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

interface BenchmarkResult {
  bundleBytes: number;
  coldBuildMs: number;
  executeMs: number;
  name: string;
  requestCount: number;
  warmBuildMs: number[];
}

const spikeDir = dirname(fileURLToPath(import.meta.url));
const osDir = resolve(spikeDir, "../..");

const appDefinitions: Array<
  Omit<BenchmarkInput, "files" | "warmIterations"> & { fixture: string }
> = [
  {
    fixture: "todo",
    name: "Todo",
    probes: [
      { expectedBodyIncludes: ["Todo", "Ship a small Worker"], expectedStatus: 200, path: "/" },
      {
        body: "title=Review+the+benchmark",
        expectedStatus: 303,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        path: "/todos",
      },
      { expectedBodyIncludes: ["Review the benchmark"], expectedStatus: 200, path: "/" },
      { expectedStatus: 303, method: "POST", path: "/todos/1/toggle" },
      {
        expectedBodyIncludes: ["<s>Ship a small Worker</s>"],
        expectedStatus: 200,
        path: "/",
      },
    ],
  },
  {
    fixture: "guestbook",
    name: "Guestbook",
    probes: [
      {
        expectedBodyIncludes: ["Guestbook", "Nobody has signed yet"],
        expectedStatus: 200,
        path: "/",
      },
      {
        body: "name=Ada&message=Hello+from+workerd",
        expectedStatus: 303,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        path: "/sign",
      },
      {
        expectedBodyIncludes: ["Ada", "Hello from workerd"],
        expectedStatus: 200,
        path: "/",
      },
    ],
  },
];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a local benchmark port.");
  }
  await new Promise<void>((resolveClosed, reject) =>
    server.close((error) => (error ? reject(error) : resolveClosed())),
  );
  return address.port;
}

async function readTree(root: string, directory = root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readTree(root, path));
    } else if (entry.isFile()) {
      files[relative(root, path)] = await readFile(path, "utf8");
    }
  }
  return files;
}

async function waitForHealth(baseUrl: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`wrangler dev exited before becoming healthy (exit ${process.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Local workerd is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out after 60s waiting for the worker-bundler spike Worker.");
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => process.once("exit", () => resolveExit())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
}

function markdown(results: BenchmarkResult[], startupMs: number): string {
  return [
    `workerd startup: ${startupMs.toFixed(1)} ms`,
    "",
    "| App | First build ms | Warm median ms | Load + flows ms | Bundle | Requests checked |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.coldBuildMs.toFixed(1)} | ${median(result.warmBuildMs).toFixed(1)} | ${result.executeMs.toFixed(1)} | ${(result.bundleBytes / 1024).toFixed(1)} KiB | ${result.requestCount} |`,
    ),
  ].join("\n");
}

async function run(): Promise<void> {
  const port = await availablePort();
  const inspectorPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let workerLog = "";
  const worker = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "spikes/worker-bundler/wrangler.jsonc",
      "--ip",
      "127.0.0.1",
      "--inspector-ip",
      "127.0.0.1",
      "--inspector-port",
      String(inspectorPort),
      "--port",
      String(port),
    ],
    { cwd: osDir, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [worker.stdout, worker.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      workerLog = `${workerLog}${chunk.toString()}`.slice(-30_000);
    });
  }

  const startupStartedAt = performance.now();
  try {
    await waitForHealth(baseUrl, worker);
    const startupMs = performance.now() - startupStartedAt;
    const filter = process.argv.slice(2).find((argument) => argument !== "--");
    const definitions = filter
      ? appDefinitions.filter((app) => app.name.toLowerCase().includes(filter.toLowerCase()))
      : appDefinitions;
    if (definitions.length === 0) throw new Error(`No app contains ${JSON.stringify(filter)}.`);

    const inputs = await Promise.all(
      definitions.map(async ({ fixture, ...definition }) => ({
        ...definition,
        files: await readTree(resolve(spikeDir, "fixtures", fixture)),
        warmIterations: 5,
      })),
    );
    const results: BenchmarkResult[] = [];
    for (const input of inputs) {
      process.stderr.write(`building and checking ${input.name}...\n`);
      const response = await fetch(`${baseUrl}/benchmark`, {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`${input.name}: ${response.status} ${await response.text()}`);
      }
      results.push((await response.json()) as BenchmarkResult);
    }

    console.log(markdown(results, startupMs));
    console.log("\nRESULTS_JSON");
    console.log(
      JSON.stringify({ measuredAt: new Date().toISOString(), results, startupMs }, null, 2),
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\nwrangler output:\n${workerLog}`,
    );
  } finally {
    await stopProcess(worker);
  }
}

await run();
