import { createServer, type Server } from "node:http";
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
});
