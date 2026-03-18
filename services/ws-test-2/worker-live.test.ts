import type { ClientRequest, IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createWsTest2Client,
  createWsTest2WebSocketClient,
  type WsTest2RpcWebSocket,
} from "@iterate-com/ws-test-2-contract";

const baseUrl = process.env.WS_TEST_2_E2E_BASE_URL?.trim();
const asRpcWebSocket = (websocket: WebSocket): WsTest2RpcWebSocket =>
  websocket as unknown as WsTest2RpcWebSocket;

function toWebSocketUrl(baseURL: string, pathname: string) {
  return baseURL.replace("http://", "ws://").replace("https://", "wss://") + pathname;
}

function requireBaseUrl() {
  if (!baseUrl) {
    throw new Error("WS_TEST_2_E2E_BASE_URL is required for live worker E2E tests");
  }

  return baseUrl;
}

function parseAssetPaths(html: string) {
  return Array.from(
    html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g),
    (match) => match[1],
  ).filter((path) => path.startsWith("/"));
}

function readWebSocketText(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as Buffer).toString("utf8");
}

async function assertConfettiInvalidPayload(url: string) {
  await new Promise<void>((resolve, reject) => {
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

    socket.on("message", (data: unknown) => {
      const text = readWebSocketText(data);
      try {
        const message = JSON.parse(text) as { type?: string };
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

async function assertOpenApiPing(url: string) {
  const client = createWsTest2Client({
    url,
    fetch,
  });
  const result = await client.ping({});
  expect(result.message).toBe("pong");
  expect(result.serverTime).toBeTruthy();
}

async function assertWebSocketRpcProtocolHandshake(baseURL: string) {
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
}

async function assertWebSocketRpcRejectsProtocol(baseURL: string, protocols?: string[]) {
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

    websocket.once("unexpected-response", (_request: ClientRequest, response: IncomingMessage) => {
      try {
        expect(response.statusCode).toBe(400);
        clearTimeout(timeout);
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });

    websocket.once("error", () => {
      // `unexpected-response` carries the assertion details.
    });
  });
}

async function assertWebSocketRpcPing(baseURL: string) {
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
}

async function assertPtyUnavailable(url: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out waiting for PTY unavailable message from ${url}`));
    }, 10_000);

    socket.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("message", (data: unknown) => {
      const text = readWebSocketText(data);
      if (text.toLowerCase().includes("not implemented")) {
        clearTimeout(timeout);
        socket.close();
        resolve();
      }
    });
  });
}

describe("ws-test-2 live worker", () => {
  it("serves shell, assets, rpc, rpc websocket, confetti websockets, and PTY not implemented", async () => {
    const currentBaseUrl = requireBaseUrl();

    const rootResponse = await fetch(`${currentBaseUrl}/`);
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("content-type")).toContain("text/html");

    const html = await rootResponse.text();
    expect(html).toContain("<title>ws-test</title>");

    const assetPaths = parseAssetPaths(html);
    expect(assetPaths.length).toBeGreaterThan(0);

    const assetResponse = await fetch(`${currentBaseUrl}${assetPaths[0]}`);
    expect(assetResponse.status).toBe(200);

    await assertOpenApiPing(currentBaseUrl);
    await assertWebSocketRpcProtocolHandshake(currentBaseUrl);
    await assertWebSocketRpcRejectsProtocol(currentBaseUrl);
    await assertWebSocketRpcRejectsProtocol(currentBaseUrl, ["wrong"]);
    await assertWebSocketRpcPing(currentBaseUrl);

    await assertConfettiInvalidPayload(toWebSocketUrl(currentBaseUrl, "/api/confetti/ws"));
    await assertConfettiSocket(toWebSocketUrl(currentBaseUrl, "/api/confetti/ws"));

    await assertPtyUnavailable(toWebSocketUrl(currentBaseUrl, "/api/pty/ws"));
  }, 30_000);
});
