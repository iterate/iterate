import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

const serviceDirectory =
  "/Users/jonastemplestein/.superset/worktrees/iterate/fly-v2-rebuilt-no-apps-os/services/ws-test-2";

const childProcesses = new Set<ReturnType<typeof spawn>>();

function parseAssetPaths(html: string) {
  return Array.from(
    html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g),
    (match) => match[1],
  ).filter((path) => path.startsWith("/"));
}

async function waitForHealthy(baseURL: string) {
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`${baseURL}/api/health`);
          return response.status;
        } catch {
          return 0;
        }
      },
      { timeout: 30_000, interval: 250 },
    )
    .toBe(200);
}

async function assertPtyCommand(url: string, expectedOutput: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    let transcript = "";

    const timeout = setTimeout(() => {
      socket.terminate();
      reject(
        new Error(`Timed out waiting for PTY output from ${url}\n\nTranscript:\n${transcript}`),
      );
    }, 10_000);

    socket.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("message", (data: any) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      transcript += text;
      if (transcript.includes(expectedOutput)) {
        clearTimeout(timeout);
        socket.close();
        resolve();
      }
    });
  });
}

async function startService(params: {
  command: string;
  args: string[];
  env: Record<string, string>;
  baseURL: string;
}) {
  const child = spawn(params.command, params.args, {
    cwd: serviceDirectory,
    env: { ...process.env, ...params.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcesses.add(child);

  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  try {
    await waitForHealthy(params.baseURL);
    return child;
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${String(error)}\n\nProcess output:\n${output}`);
  }
}

async function stopService(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.killed) {
    childProcesses.delete(child);
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    delay(5_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
  childProcesses.delete(child);
}

async function assertServiceWorks(params: { baseURL: string }) {
  const rootResponse = await fetch(`${params.baseURL}/`);
  expect(rootResponse.status).toBe(200);
  expect(rootResponse.headers.get("content-type")).toContain("text/html");

  const html = await rootResponse.text();
  expect(html).toContain("<title>ws-test</title>");

  const assetPaths = parseAssetPaths(html);
  expect(assetPaths.length).toBeGreaterThan(0);

  const assetResponse = await fetch(`${params.baseURL}${assetPaths[0]}`);
  expect(assetResponse.status).toBe(200);

  const rpcResponse = await fetch(`${params.baseURL}/api/rpc/ping`);
  expect(rpcResponse.status).toBe(200);
  expect(await rpcResponse.text()).toContain('"message":"pong"');

  await assertPtyCommand(
    params.baseURL.replace("http://", "ws://").replace("https://", "wss://") +
      "/api/pty/ws?command=printf%20WS_TEST_HELLO&autorun=true",
    "WS_TEST_HELLO",
  );
}

beforeAll(async () => {
  const build = spawn("pnpm", ["build"], {
    cwd: serviceDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  build.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  build.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    build.once("exit", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`ws-test build failed with exit code ${String(exitCode)}\n\n${output}`);
  }
}, 120_000);

afterEach(async () => {
  await Promise.all(Array.from(childProcesses, (child) => stopService(child)));
});

describe("ws-test end-to-end", () => {
  test("dev server serves shell, assets, oRPC, and PTY websockets", async () => {
    const baseURL = "http://127.0.0.1:5191";
    const child = await startService({
      command: "pnpm",
      args: ["dev"],
      env: {
        PORT: "5191",
      },
      baseURL,
    });

    try {
      await assertServiceWorks({
        baseURL,
      });
    } finally {
      await stopService(child);
    }
  }, 60_000);

  test("production server serves shell, built assets, oRPC, and PTY websockets", async () => {
    const baseURL = "http://127.0.0.1:5192";
    const child = await startService({
      command: "pnpm",
      args: ["start"],
      env: {
        PORT: "5192",
      },
      baseURL,
    });

    try {
      await assertServiceWorks({
        baseURL,
      });
    } finally {
      await stopService(child);
    }
  }, 60_000);
});
