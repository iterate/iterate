import { createServer, type Server } from "node:http";
import { describe, expect, test } from "vitest";
import { isFetchBlockedPort, listenOnFetchSafePort } from "./fetch-safe-listen.ts";

describe("listenOnFetchSafePort", () => {
  test("retries ephemeral ports that Fetch would block", async () => {
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    const blockedPorts: number[] = [];
    let calls = 0;

    const result = await listenOnFetchSafePort(server, {
      maxAttempts: 3,
      isFetchBlockedPort(port) {
        calls += 1;
        if (calls === 1) {
          blockedPorts.push(port);
          return true;
        }
        return false;
      },
    });

    try {
      expect(calls).toBe(2);
      expect(result.port).not.toBe(blockedPorts[0]);

      const response = await fetch(result.baseUrl);
      await expect(response.text()).resolves.toBe("ok");
    } finally {
      await close(server);
    }
  });

  test("identifies ports blocked by Fetch", () => {
    expect(isFetchBlockedPort(10080)).toBe(true);
    expect(isFetchBlockedPort(6667)).toBe(true);
    expect(isFetchBlockedPort(3000)).toBe(false);
  });
});

async function close(server: Server): Promise<void> {
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
