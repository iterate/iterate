import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Event, EventInput, StreamPath } from "@iterate-com/events-contract";
import { describe, expect, test } from "vitest";
import { pingPongDynamicWorkerScript } from "../../src/durable-objects/dynamic-processor.ts";
import { collectAsyncIterableUntilIdle, createEvents2AppFixture } from "../helpers.ts";

const configuredEventType = "https://events.iterate.com/events/stream/dynamic-worker/configured";
const valueRecordedEventType = "https://events.iterate.com/events/example/value-recorded";
const localBaseUrl = "http://localhost:5173";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const altPongDynamicWorkerScript = pingPongDynamicWorkerScript.replace(
  'await append({ type: "pong" });',
  'await append({ type: "alt-pong" });',
);
const describeLocalRestart = process.env.CI ? describe.skip : describe.sequential;

describeLocalRestart("dynamic worker restart", () => {
  test("multiple configured workers survive a dev-server restart and react again after wake-up", async () => {
    const server = createLocalEventsServer();
    const path = uniqueDynamicWorkerPath();

    try {
      await server.start();

      await configureWorker({
        path,
        script: pingPongDynamicWorkerScript,
        slug: "alpha",
      });
      await configureWorker({
        path,
        script: altPongDynamicWorkerScript,
        slug: "beta",
      });
      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "ping before restart" },
      });
      await waitForEventCounts({
        path,
        totalEvents: 6,
        counts: {
          [configuredEventType]: 2,
          [valueRecordedEventType]: 1,
          pong: 1,
          "alt-pong": 1,
        },
      });

      await server.restart();

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "ping after restart" },
      });

      const history = await waitForEventCounts({
        path,
        totalEvents: 9,
        counts: {
          [configuredEventType]: 2,
          [valueRecordedEventType]: 2,
          pong: 2,
          "alt-pong": 2,
        },
      });

      expect(history.filter((event) => event.type === "pong")).toHaveLength(2);
      expect(history.filter((event) => event.type === "alt-pong")).toHaveLength(2);
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("hot-swapped worker config survives a dev-server restart without reviving the old runtime", async () => {
    const server = createLocalEventsServer();
    const path = uniqueDynamicWorkerPath();

    try {
      await server.start();

      await configureWorker({
        path,
        script: pingPongDynamicWorkerScript,
        slug: "alpha",
      });
      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "first ping" },
      });
      await waitForEventCounts({
        path,
        totalEvents: 4,
        counts: {
          [configuredEventType]: 1,
          [valueRecordedEventType]: 1,
          pong: 1,
        },
      });

      await configureWorker({
        path,
        script: altPongDynamicWorkerScript,
        slug: "alpha",
      });
      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "second ping after swap" },
      });
      await waitForEventCounts({
        path,
        totalEvents: 7,
        counts: {
          [configuredEventType]: 2,
          [valueRecordedEventType]: 2,
          pong: 1,
          "alt-pong": 1,
        },
      });

      await server.restart();

      await append(path, {
        type: valueRecordedEventType,
        payload: { message: "third ping after restart" },
      });

      const history = await waitForEventCounts({
        path,
        totalEvents: 9,
        counts: {
          [configuredEventType]: 2,
          [valueRecordedEventType]: 3,
          pong: 1,
          "alt-pong": 2,
        },
      });

      expect(history.filter((event) => event.type === "pong")).toHaveLength(1);
      expect(history.filter((event) => event.type === "alt-pong")).toHaveLength(2);
    } finally {
      await server.stop();
    }
  }, 180_000);
});

function createLocalEventsServer() {
  let child: ChildProcessWithoutNullStreams | null = null;
  let output = "";
  const app = createEvents2AppFixture({ baseURL: localBaseUrl });

  return {
    async start() {
      if (child != null) {
        throw new Error("local events dev server is already running");
      }

      if (await isServerReachable()) {
        throw new Error(
          "http://localhost:5173 is already in use; stop the existing apps/events dev server first",
        );
      }

      child = spawn("pnpm", ["--dir", "apps/events", "dev"], {
        cwd: repoRoot,
        detached: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const nextChild = child;

      nextChild.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      nextChild.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });

      nextChild.on("exit", (code, signal) => {
        output += `\n[dynamic-worker-restart.local.e2e] exited code=${code} signal=${signal}\n`;
      });

      await waitForReady(app);
    },

    async stop() {
      if (child == null) {
        return;
      }

      const running = child;
      child = null;
      killProcessGroup(running.pid, "SIGTERM");

      await Promise.race([
        new Promise<void>((resolve) => {
          running.once("exit", () => resolve());
        }),
        delay(5_000).then(() => {
          killProcessGroup(running.pid, "SIGKILL");
        }),
      ]);

      await waitForServerToStop();
    },

    async restart() {
      await this.stop();
      await this.start();
    },

    getOutput() {
      return output;
    },
  };
}

async function waitForReady(_app: ReturnType<typeof createEvents2AppFixture>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/", localBaseUrl), {
        signal: AbortSignal.timeout(2_000),
      });

      if (response.ok) {
        return;
      }

      lastError = new Error(`GET / -> ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw new Error(`timed out waiting for local events dev server readiness: ${String(lastError)}`);
}

async function waitForServerToStop(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isServerReachable())) {
      return;
    }

    await delay(250);
  }

  throw new Error("timed out waiting for local events dev server to stop");
}

async function isServerReachable() {
  try {
    const response = await fetch(new URL("/", localBaseUrl), {
      signal: AbortSignal.timeout(1_000),
    });

    return response.ok || response.status >= 300;
  } catch {
    return false;
  }
}

async function waitForEventCounts(args: {
  counts: Record<string, number>;
  path: StreamPath;
  timeoutMs?: number;
  totalEvents: number;
}) {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastHistory: Event[] = [];

  while (Date.now() < deadline) {
    lastHistory = await readHistory(args.path);
    if (
      lastHistory.length === args.totalEvents &&
      Object.entries(args.counts).every(([type, count]) => {
        return lastHistory.filter((event) => event.type === type).length === count;
      })
    ) {
      return lastHistory;
    }

    await delay(300);
  }

  throw new Error(
    `timed out waiting for event counts ${JSON.stringify(args.counts)} with total ${args.totalEvents}; last history was ${lastHistory
      .map((event) => event.type)
      .join(", ")}`,
  );
}

async function readHistory(path: StreamPath) {
  const app = createEvents2AppFixture({ baseURL: localBaseUrl });
  return (await collectAsyncIterableUntilIdle({
    iterable: await app.client.stream({ path, live: false }),
    idleMs: 500,
  })) as Event[];
}

async function configureWorker(args: { path: StreamPath; script: string; slug: string }) {
  await append(args.path, {
    type: configuredEventType,
    payload: {
      slug: args.slug,
      script: args.script,
    },
  });
}

async function append(path: StreamPath, event: EventInput) {
  const app = createEvents2AppFixture({ baseURL: localBaseUrl });
  await app.append({
    streamPath: path,
    event,
  });
}

function uniqueDynamicWorkerPath() {
  const id = randomUUID().slice(0, 8);
  return `/dynamic-worker-restart/${id}/stream` as StreamPath;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid == null) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}
