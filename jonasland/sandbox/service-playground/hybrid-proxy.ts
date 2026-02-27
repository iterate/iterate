/**
 * Hybrid TCP/HTTP proxy.
 *
 * Sits in front of an inner service. Peeks at the first bytes of each
 * connection to decide:
 *   - If it's HTTP hitting one of our managed paths (/service/*, /openapi.json),
 *     route to our Hono app via an internal HTTP server.
 *   - Everything else (HTTP to the inner service, raw TCP, WebSocket upgrades)
 *     gets piped straight through as an L4 proxy. Zero inspection.
 */
import { createServer as createNetServer, connect, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { Hono } from "hono";

const MANAGED_PATH_PREFIXES = ["/service/", "/openapi.json", "/orpc"];

function isHttpAndManaged(chunk: Buffer): boolean {
  const head = chunk.toString("ascii", 0, Math.min(chunk.length, 512));
  if (!/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) /.test(head)) {
    return false;
  }
  const crlfIdx = head.indexOf("\r\n");
  const firstLine = crlfIdx === -1 ? head : head.slice(0, crlfIdx);
  const path = firstLine.split(" ")[1] || "";
  return MANAGED_PATH_PREFIXES.some((p) => path.startsWith(p));
}

export interface HybridProxyOptions {
  innerPort: number;
  app: Hono;
}

export interface HybridProxyHandle {
  port: number;
  close(): void;
}

export function createHybridProxy(opts: HybridProxyOptions): Promise<HybridProxyHandle> {
  const { innerPort, app } = opts;

  // Internal HTTP server for managed routes — Hono handles the requests
  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = `http://127.0.0.1${req.url || "/"}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const body =
        req.method !== "GET" && req.method !== "HEAD"
          ? await new Promise<Buffer>((resolve) => {
              const chunks: Buffer[] = [];
              req.on("data", (c: Buffer) => chunks.push(c));
              req.on("end", () => resolve(Buffer.concat(chunks)));
            })
          : undefined;

      const response = await app.fetch(new Request(url, { method: req.method, headers, body }));

      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch {
      res.writeHead(502);
      res.end("proxy error");
    }
  });

  return new Promise<HybridProxyHandle>((resolve) => {
    // Listen on an internal port for managed HTTP
    httpServer.listen(0, "127.0.0.1", () => {
      const httpAddr = httpServer.address();
      if (!httpAddr || typeof httpAddr === "string") throw new Error("httpServer bind failed");
      const httpPort = httpAddr.port;

      // The outer TCP server — entrypoint for all connections
      const tcpServer: Server = createNetServer((socket) => {
        socket.once("data", (firstChunk: Buffer) => {
          // Pause immediately to prevent data loss between once("data") and pipe()
          socket.pause();

          // Decide where to route based on first bytes
          const targetPort = isHttpAndManaged(firstChunk) ? httpPort : innerPort;

          const proxy = connect(targetPort, "127.0.0.1", () => {
            proxy.write(firstChunk);
            socket.pipe(proxy); // pipe() calls resume() internally
            proxy.pipe(socket);
          });
          proxy.on("error", () => socket.destroy());
          socket.on("error", () => proxy.destroy());
        });

        socket.on("error", () => {});
      });

      tcpServer.listen(0, "127.0.0.1", () => {
        const addr = tcpServer.address();
        if (!addr || typeof addr === "string") throw new Error("tcpServer bind failed");
        resolve({
          port: addr.port,
          close() {
            tcpServer.close();
            httpServer.close();
          },
        });
      });
    });
  });
}
