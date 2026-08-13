import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { newWebSocketRpcSession, RpcTarget } from "@iterate-com/capnweb";
import { WebSocketServer } from "ws";
import { connectItxReady } from "./itx-node-client.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("connectItxReady", () => {
  test("retries one failed initial transport before returning a proven capability", async () => {
    const server = await startRpcServer({ rejectUpgradeCount: 1 });
    const onRetry = vi.fn();

    using itx = await connectItxReady(
      { baseUrl: server.baseUrl },
      {
        retryInitialConnection: {
          delayMs: 0,
          onRetry,
        },
      },
    );

    expect(await itx.__describe()).toEqual({ name: "test target" });
    expect(server.upgradeCount()).toBe(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 0,
        failedAttempt: 1,
        nextAttempt: 2,
      }),
    );
  });

  test("does not retry an application failure after the connection is returned", async () => {
    const server = await startRpcServer({ describeError: new Error("application probe failed") });
    const onRetry = vi.fn();

    using itx = await connectItxReady(
      { baseUrl: server.baseUrl },
      {
        retryInitialConnection: {
          delayMs: 0,
          onRetry,
        },
      },
    );
    await expect(itx.__describe()).rejects.toThrow("application probe failed");

    expect(server.upgradeCount()).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("bounds an unavailable endpoint to the original dial and one retry", async () => {
    const server = await startRpcServer({ rejectUpgradeCount: 2 });

    await expect(
      connectItxReady({ baseUrl: server.baseUrl }, { retryInitialConnection: { delayMs: 0 } }),
    ).rejects.toThrow(/socket hang up|closed before connecting/u);

    expect(server.upgradeCount()).toBe(2);
  });
});

async function startRpcServer(options: { describeError?: Error; rejectUpgradeCount?: number }) {
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  let upgradeCount = 0;

  httpServer.on("upgrade", (request, socket, head) => {
    upgradeCount += 1;
    if (upgradeCount <= (options.rejectUpgradeCount ?? 0)) {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    webSocket.on("error", () => {});
    newWebSocketRpcSession(
      webSocket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
      new DescribeTarget(options.describeError),
    );
  });

  await listen(httpServer);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an IP test server address.");
  }

  cleanups.push(async () => {
    for (const client of webSocketServer.clients) client.terminate();
    await Promise.all([closeWebSocketServer(webSocketServer), closeHttpServer(httpServer)]);
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    upgradeCount: () => upgradeCount,
  };
}

class DescribeTarget extends RpcTarget {
  private readonly error: Error | undefined;

  constructor(error: Error | undefined) {
    super();
    this.error = error;
  }

  __describe() {
    if (this.error) throw this.error;
    return { name: "test target" };
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
