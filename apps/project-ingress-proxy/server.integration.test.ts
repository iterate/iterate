import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startProjectIngressProxyServer } from "./server.ts";

function getServerPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server to be bound to a TCP port");
  }
  return (address as AddressInfo).port;
}

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

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("project ingress proxy integration", () => {
  let proxyServer: Server;
  let proxyPort: number;

  beforeAll(async () => {
    proxyServer = await startProjectIngressProxyServer({ host: "127.0.0.1", port: 0 });
    proxyPort = getServerPort(proxyServer);
  });

  afterAll(async () => {
    await closeServer(proxyServer);
  });

  it("returns health status on /health", async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("returns 400 when target header is missing", async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/hello`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "missing_proxy_target_host" });
  });

  it("proxies HTTP requests and rewrites headers", async () => {
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        const payload = JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(payload);
      });
    });

    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = getServerPort(upstream);

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/foo?hello=world`, {
        method: "POST",
        headers: {
          "X-Iterate-Proxy-Target-Host": `${upstreamPort}__banana.boopie.lala.internal`,
          "Content-Type": "text/plain",
        },
        body: "hello-through-proxy",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        method: string;
        url: string;
        body: string;
        headers: IncomingHttpHeaders;
      };

      expect(body.method).toBe("POST");
      expect(body.url).toBe("/foo?hello=world");
      expect(body.body).toBe("hello-through-proxy");
      expect(body.headers.host).toBe(`localhost:${upstreamPort}`);
      expect(body.headers["x-iterate-proxy-via"]).toBe(`127.0.0.1:${proxyPort}`);
      expect(body.headers["x-iterate-proxy-target-host"]).toBeUndefined();
    } finally {
      await closeServer(upstream);
    }
  });

  it("proxies websocket traffic transparently", async () => {
    const wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wsServer, "listening");

    const address = wsServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected websocket server address");
    }

    const wsPort = address.port;
    let upstreamHeaders: IncomingHttpHeaders | null = null;

    wsServer.on("connection", (socket, request) => {
      upstreamHeaders = request.headers;
      socket.on("message", (message) => {
        socket.send(`echo:${message.toString()}`);
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/socket`, {
      headers: {
        "X-Iterate-Proxy-Target-Host": `${wsPort}__socket.internal`,
      },
    });

    try {
      await once(client, "open");
      client.send("ping");

      const [message] = await once(client, "message");
      expect(String(message)).toBe("echo:ping");
      expect(upstreamHeaders?.["host"]).toBe(`localhost:${wsPort}`);
      expect(upstreamHeaders?.["x-iterate-proxy-via"]).toBe(`127.0.0.1:${proxyPort}`);
      expect(upstreamHeaders?.["x-iterate-proxy-target-host"]).toBeUndefined();
    } finally {
      client.close();
      await once(client, "close");
      await closeWebSocketServer(wsServer);
    }
  });
});
