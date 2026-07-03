import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { listenOnFetchSafePort } from "./fetch-safe-listen.ts";

async function closeServer(server: Server): Promise<void> {
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

describe("listenOnFetchSafePort", () => {
  test("rejects instead of hanging when a fixed safe port cannot bind", async () => {
    const blocker = createServer();
    const candidate = createServer();

    try {
      const { port } = await listenOnFetchSafePort(blocker);

      await expect(listenOnFetchSafePort(candidate, { port })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await closeServer(blocker);
    }
  });

  test("retries ephemeral bind conflicts without closing the caller's server", async () => {
    const events = new EventEmitter();
    const listenedPorts: number[] = [];
    let closeCalls = 0;

    const server = Object.assign(events, {
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: listenedPorts.at(-1)! }),
      close: (callback?: (error?: Error) => void) => {
        closeCalls++;
        callback?.();
        return server;
      },
      listen: (port: number) => {
        listenedPorts.push(port);
        queueMicrotask(() => {
          if (listenedPorts.length === 1) {
            const error = Object.assign(new Error("port in use"), { code: "EADDRINUSE" });
            events.emit("error", error);
            return;
          }
          events.emit("listening");
        });
        return server;
      },
    }) as unknown as Server;

    const result = await listenOnFetchSafePort(server);

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: listenedPorts.at(-1),
    });
    expect(listenedPorts).toHaveLength(2);
    expect(listenedPorts).not.toContain(0);
    expect(closeCalls).toBe(0);
  });
});
