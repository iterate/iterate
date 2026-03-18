import { setTimeout as delay } from "node:timers/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { getPort } from "get-port-please";
import { x, type Result } from "tinyexec";
import {
  createWsTest2Client,
  createWsTest2WebSocketClient,
  type WsTest2RpcWebSocket,
} from "@iterate-com/ws-test-2-contract";

const serviceDirectory =
  "/Users/jonastemplestein/.superset/worktrees/iterate/fly-v2-rebuilt-no-apps-os/services/ws-test-2";

const childProcesses = new Set<Result>();
const COMMAND_PREFIX = "\x00[command]\x00";
const asRpcWebSocket = (websocket: WebSocket): WsTest2RpcWebSocket =>
  websocket as unknown as WsTest2RpcWebSocket;

function toWebSocketUrl(baseURL: string, pathname: string) {
  return baseURL.replace("http://", "ws://").replace("https://", "wss://") + pathname;
}

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

async function retryUntilSuccess(label: string, action: () => Promise<void>, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  const errorMessage =
    lastError instanceof Error
      ? lastError.message
      : lastError === undefined
        ? "unknown"
        : String(lastError);
  throw new Error(`${label}: ${errorMessage}`);
}

function readWebSocketText(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as Buffer).toString("utf8");
}

async function assertOpenApiPing(baseURL: string) {
  const client = createWsTest2Client({
    url: baseURL,
    fetch,
  });
  const result = await client.ping({});
  expect(result.message).toBe("pong");
  expect(result.serverTime).toBeTruthy();
}

async function assertWebSocketRpcProtocolHandshake(baseURL: string) {
  await retryUntilSuccess("websocket rpc protocol handshake", async () => {
    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(toWebSocketUrl(baseURL, "/api/orpc/ws"), ["orpc"]);
      const timeout = setTimeout(() => {
        websocket.terminate();
        reject(new Error("Timed out waiting for websocket rpc handshake"));
      }, 10_000);

      websocket.once("open", () => {
        try {
          expect(websocket.protocol).toBe("orpc");
          clearTimeout(timeout);
          websocket.close();
          resolve();
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      websocket.once("error", (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  });
}

async function assertWebSocketRpcRejectsProtocol(baseURL: string, protocols?: string[]) {
  await retryUntilSuccess(
    `websocket rpc rejects protocol ${protocols?.join(",") ?? "none"}`,
    async () => {
      await new Promise<void>((resolve, reject) => {
        const websocket = protocols
          ? new WebSocket(toWebSocketUrl(baseURL, "/api/orpc/ws"), protocols)
          : new WebSocket(toWebSocketUrl(baseURL, "/api/orpc/ws"));
        const timeout = setTimeout(() => {
          websocket.terminate();
          reject(new Error("Timed out waiting for websocket rpc rejection"));
        }, 10_000);

        websocket.once("open", () => {
          clearTimeout(timeout);
          reject(new Error("Expected websocket rpc handshake to fail"));
        });

        websocket.once(
          "unexpected-response",
          (_request: ClientRequest, response: IncomingMessage) => {
            try {
              expect(response.statusCode).toBe(400);
              clearTimeout(timeout);
              resolve();
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          },
        );

        websocket.once("error", () => {
          // `unexpected-response` carries the assertion details.
        });
      });
    },
  );
}

async function assertWebSocketRpcPing(baseURL: string) {
  await retryUntilSuccess("websocket rpc ping", async () => {
    const websocket = new WebSocket(toWebSocketUrl(baseURL, "/api/orpc/ws"), ["orpc"]);
    const client = createWsTest2WebSocketClient({
      websocket: asRpcWebSocket(websocket),
    });

    try {
      const result = await client.ping({});
      expect(result.message).toBe("pong");
      expect(result.serverTime).toBeTruthy();
    } finally {
      websocket.close();
    }
  });
}

function parsePtyControlMessage(text: string) {
  if (!text.startsWith(COMMAND_PREFIX)) return null;

  return JSON.parse(text.slice(COMMAND_PREFIX.length)) as {
    type?: string;
    ptyId?: string;
    data?: string;
  };
}

async function assertPtyCommand(url: string, expectedOutput: string) {
  await retryUntilSuccess(
    "pty websocket",
    () =>
      new Promise<void>((resolve, reject) => {
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
          const text = readWebSocketText(data);
          transcript += text;
          if (transcript.includes(expectedOutput)) {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        });
      }),
    12_000,
  );
}

async function assertPtyResume(baseURL: string) {
  await retryUntilSuccess(
    "pty websocket resume",
    async () => {
      const initialCommand = "printf WS_TEST_RESUME";
      const resumedCommand = "printf WS_TEST_RESUMED";
      const initialPtyId = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(
          toWebSocketUrl(
            baseURL,
            `/api/pty/ws?command=${encodeURIComponent(initialCommand)}&autorun=true`,
          ),
        );
        let transcript = "";
        let ptyId: string | undefined;
        const timeout = setTimeout(() => {
          socket.terminate();
          reject(
            new Error(`Timed out waiting for PTY resume seed output\n\nTranscript:\n${transcript}`),
          );
        }, 10_000);

        socket.once("error", (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        });

        socket.on("message", (data: unknown) => {
          const text = readWebSocketText(data);
          const control = parsePtyControlMessage(text);
          if (control?.type === "ptyId" && control.ptyId) {
            ptyId = control.ptyId;
          }

          if (!control) {
            transcript += text;
          }

          if (ptyId && transcript.includes("WS_TEST_RESUME")) {
            clearTimeout(timeout);
            socket.close();
            resolve(ptyId);
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          toWebSocketUrl(baseURL, `/api/pty/ws?ptyId=${encodeURIComponent(initialPtyId)}`),
        );
        let transcript = "";
        let sawBufferReplay = false;
        const timeout = setTimeout(() => {
          socket.terminate();
          reject(
            new Error(
              `Timed out waiting for PTY resume replay\n\nTranscript:\n${transcript}\n\nSaw buffer replay: ${String(
                sawBufferReplay,
              )}`,
            ),
          );
        }, 10_000);

        socket.once("open", () => {
          socket.send(
            COMMAND_PREFIX +
              JSON.stringify({
                type: "exec",
                command: resumedCommand,
                autorun: true,
              }),
          );
        });

        socket.once("error", (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        });

        socket.on("message", (data: unknown) => {
          const text = readWebSocketText(data);
          const control = parsePtyControlMessage(text);

          if (control?.type === "buffer" && control.data?.includes("WS_TEST_RESUME")) {
            sawBufferReplay = true;
          }

          if (!control) {
            transcript += text;
          }

          if (sawBufferReplay && transcript.includes("WS_TEST_RESUMED")) {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        });
      });
    },
    15_000,
  );
}

async function assertConfettiInvalidPayload(url: string) {
  await retryUntilSuccess(
    "confetti invalid payload",
    () =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        const timeout = setTimeout(() => {
          socket.terminate();
          reject(new Error(`Timed out waiting for confetti error response from ${url}`));
        }, 10_000);

        socket.once("open", () => {
          socket.send("not-json");
        });

        socket.once("error", (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        });

        socket.on("message", (data: unknown) => {
          const text = readWebSocketText(data);
          try {
            const message = JSON.parse(text) as { type?: string; message?: string };
            if (message.type === "error") {
              expect(message.message).toBe("Invalid confetti payload");
              clearTimeout(timeout);
              socket.close();
              resolve();
            }
          } catch {
            // Ignore non-JSON frames.
          }
        });
      }),
    12_000,
  );
}

async function assertConfettiSocket(url: string) {
  await retryUntilSuccess(
    "confetti websocket",
    () =>
      new Promise<void>((resolve, reject) => {
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
          const text = readWebSocketText(data);
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
      }),
    12_000,
  );
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

async function readChildOutput(child: Result) {
  try {
    const result = await Promise.resolve(child);
    return `${result.stdout}${result.stderr}`;
  } catch (childError) {
    if (childError instanceof Error && "output" in childError) {
      const maybeOutput = childError.output as { stdout?: string; stderr?: string };
      return `${maybeOutput.stdout ?? ""}${maybeOutput.stderr ?? ""}`;
    }
    if (childError instanceof Error) {
      return childError.message;
    }
    return String(childError);
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

  await assertOpenApiPing(params.baseURL);
  await assertWebSocketRpcProtocolHandshake(params.baseURL);
  await assertWebSocketRpcRejectsProtocol(params.baseURL);
  await assertWebSocketRpcRejectsProtocol(params.baseURL, ["wrong"]);
  await assertWebSocketRpcPing(params.baseURL);

  await assertConfettiInvalidPayload(toWebSocketUrl(params.baseURL, "/api/confetti/ws"));
  await assertConfettiSocket(toWebSocketUrl(params.baseURL, "/api/confetti/ws"));

  await assertPtyCommand(
    `${toWebSocketUrl(params.baseURL, "/api/pty/ws")}?command=printf%20WS_TEST_HELLO&autorun=true`,
    "WS_TEST_HELLO",
  );
  await assertPtyResume(params.baseURL);
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
    const child = startProcess(["cli", "dev", "--port", String(port)]);
    await waitForService({
      child,
      baseURL,
    });

    try {
      await assertServiceWorks({
        baseURL,
      });
    } catch (error) {
      await stopService(child);
      const output = await readChildOutput(child);
      throw new Error(`${String(error)}\n\nProcess output:\n${output}`);
    } finally {
      await stopService(child);
    }
  }, 60_000);

  test("production server serves shell, built assets, oRPC, and PTY websockets", async () => {
    const port = await getPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const child = startProcess(["cli", "preview", "--port", String(port)]);
    await waitForService({
      child,
      baseURL,
    });

    try {
      await assertServiceWorks({
        baseURL,
      });
    } catch (error) {
      await stopService(child);
      const output = await readChildOutput(child);
      throw new Error(`${String(error)}\n\nProcess output:\n${output}`);
    } finally {
      await stopService(child);
    }
  }, 60_000);
});
