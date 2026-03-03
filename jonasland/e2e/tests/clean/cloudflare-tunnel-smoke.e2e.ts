import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import { useCloudflareTunnel } from "../../test-helpers/use-cloudflare-tunnel.ts";

describe("clean cloudflare tunnel smoke", () => {
  test("forwards a request into a local echo server", async () => {
    const server = createServer(async (request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("failed to bind local echo server");
    }

    try {
      await using tunnel = await useCloudflareTunnel({
        localPort: address.port,
        cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
        timeoutMs: 120_000,
      });

      const requestBody = JSON.stringify({ hello: "world" });
      const response = await fetch(`${tunnel.tunnelUrl}/echo?source=vitest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-jonasland-test": "1",
        },
        body: requestBody,
        signal: AbortSignal.timeout(20_000),
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        method: string;
        url: string;
        headers: Record<string, string | string[] | undefined>;
        body: string;
      };

      expect(payload.method).toBe("POST");
      expect(payload.url).toContain("/echo?source=vitest");
      expect(payload.body).toBe(requestBody);

      const xJonasland = payload.headers["x-jonasland-test"];
      expect(Array.isArray(xJonasland) ? xJonasland[0] : xJonasland).toBe("1");
    } finally {
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
  }, 300_000);
});
