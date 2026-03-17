import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWsTest2Client } from "@iterate-com/ws-test-2-contract";

const baseUrl = process.env.WS_TEST_2_E2E_BASE_URL?.trim();

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

    socket.on("message", (data: any) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (text.toLowerCase().includes("not implemented")) {
        clearTimeout(timeout);
        socket.close();
        resolve();
      }
    });
  });
}

describe("ws-test-2 live worker", () => {
  it("serves shell, assets, rpc, confetti websockets, and PTY not implemented", async () => {
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

    await assertConfettiSocket(
      currentBaseUrl.replace("http://", "ws://").replace("https://", "wss://") + "/api/confetti/ws",
    );

    await assertPtyUnavailable(
      currentBaseUrl.replace("http://", "ws://").replace("https://", "wss://") + "/api/pty/ws",
    );
  });
});
