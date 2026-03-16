import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { getPort } from "get-port-please";
import { x, type Result } from "tinyexec";

const serviceDirectory =
  "/Users/jonastemplestein/.superset/worktrees/iterate/fly-v2-rebuilt-no-apps-os/services/ws-test-2";

const childProcesses = new Set<Result>();

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

async function assertConfettiSocket(url: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out waiting for confetti websocket response from ${url}`));
    }, 10_000);

    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          type: "launch",
          x: 0.5,
          y: 0.25,
        }),
      );
    });

    socket.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("message", (data: any) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      try {
        const message = JSON.parse(text) as { type?: string; x?: number; y?: number };
        if (message.type === "boom") {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
  });
}

function startProcess(args: string[]) {
  const child = x("pnpm", args, {
    persist: true,
    throwOnError: true,
    nodeOptions: {
      cwd: serviceDirectory,
      env: process.env,
      stdio: "pipe",
    },
  });
  childProcesses.add(child);
  return child;
}

async function waitForService(params: { child: Result; baseURL: string }) {
  try {
    await waitForHealthy(params.baseURL);
  } catch (error) {
    params.child.kill("SIGTERM");

    let output = "";
    try {
      const result = await params.child;
      output = `${result.stdout}${result.stderr}`;
    } catch (childError) {
      if (childError instanceof Error && "output" in childError) {
        const maybeOutput = childError.output as { stdout?: string; stderr?: string };
        output = `${maybeOutput.stdout ?? ""}${maybeOutput.stderr ?? ""}`;
      } else if (childError instanceof Error) {
        output = childError.message;
      } else {
        output = String(childError);
      }
    }

    throw new Error(`${String(error)}\n\nProcess output:\n${output}`);
  }
}

async function stopService(child: Result) {
  if (child.exitCode !== null || child.killed) {
    childProcesses.delete(child);
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    Promise.resolve(child).then(
      () => undefined,
      () => undefined,
    ),
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

  await assertConfettiSocket(
    params.baseURL.replace("http://", "ws://").replace("https://", "wss://") + "/api/confetti/ws",
  );

  await assertPtyCommand(
    params.baseURL.replace("http://", "ws://").replace("https://", "wss://") +
      "/api/pty/ws?command=printf%20WS_TEST_HELLO&autorun=true",
    "WS_TEST_HELLO",
  );
}

beforeAll(async () => {
  await x("pnpm", ["build"], {
    throwOnError: true,
    nodeOptions: {
      cwd: serviceDirectory,
      env: process.env,
      stdio: "pipe",
    },
  });
}, 120_000);

afterEach(async () => {
  await Promise.all(Array.from(childProcesses, (child) => stopService(child)));
});

describe("ws-test end-to-end", () => {
  test("dev server serves shell, assets, oRPC, and PTY websockets", async () => {
    const port = await getPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const child = startProcess(["dev", "--port", String(port)]);
    await waitForService({
      child,
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
    const port = await getPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const child = startProcess(["preview", "--port", String(port)]);
    await waitForService({
      child,
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
