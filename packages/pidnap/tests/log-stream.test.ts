import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { RPCHandler } from "@orpc/server/node";
import type { Manager } from "../src/manager.ts";
import { createClient } from "../src/api/client.ts";
import { router } from "../src/api/server.ts";

describe("process log stream", () => {
  const cleanupPaths: string[] = [];
  const cleanupServers: Server[] = [];

  afterEach(async () => {
    for (const server of cleanupServers.splice(0)) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("yields initial tail rows and appended rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "pidnap-log-stream-"));
    cleanupPaths.push(root);

    const logPath = join(root, "worker.log");
    writeFileSync(logPath, "first\nsecond\n", "utf-8");

    const server = await startTestServer(createTestManager(logPath));
    cleanupServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve test server address");
    }

    const client = createClient(`http://127.0.0.1:${address.port}/rpc`);
    const controller = new AbortController();
    const stream = await client.processes.logs(
      { processSlug: "worker", tailLines: 10, pollIntervalMs: 20 },
      { signal: controller.signal },
    );
    const iterator = stream[Symbol.asyncIterator]();

    expect(await nextWithTimeout(iterator)).toEqual({ text: "first" });
    expect(await nextWithTimeout(iterator)).toEqual({ text: "second" });

    appendFileSync(logPath, "third\n", "utf-8");
    expect(await nextWithTimeout(iterator)).toEqual({ text: "third" });

    controller.abort();
    await iterator.return?.();
  });
});

async function startTestServer(manager: Manager): Promise<Server> {
  const handler = new RPCHandler(router);
  const server = createServer(async (req, res) => {
    const { matched } = await handler.handle(req, res, {
      prefix: "/rpc",
      context: { manager },
    });

    if (!matched) {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return server;
}

function createTestManager(logPath: string): Manager {
  return new TestManager(logPath) as unknown as Manager;
}

class TestManager {
  state = "running" as const;

  constructor(private readonly logPath: string) {}

  getProcessByTarget(target: string | number) {
    if (target !== "worker") {
      return undefined;
    }

    return { name: "worker" };
  }

  getProcessLogPath(name: string) {
    if (name !== "worker") {
      throw new Error(`Unexpected process name: ${name}`);
    }

    return this.logPath;
  }
}

async function nextWithTimeout<T>(iterator: AsyncIterator<T>, timeoutMs = 1_000): Promise<T> {
  const next = await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<T>>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timed out waiting for stream item after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);

  if (next.done) {
    throw new Error("Stream ended before yielding the next item");
  }

  return next.value;
}
