import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { MockEgressProxy } from "../src/index.ts";

type Address = { address: string; port: number };

const TARGET_URL_HEADER = "x-iterate-target-url";
let harDirPath = "";

function getAddress(server: Server): Address {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to be listening on a TCP port");
  }
  const host =
    address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;
  return { address: host, port: address.port };
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

async function readHar(
  path: string,
): Promise<{ log: { entries: Array<Record<string, unknown>> } }> {
  return JSON.parse(await readFile(path, "utf8")) as {
    log: { entries: Array<Record<string, unknown>> };
  };
}

function harPathFor(testName: string): string {
  return join(harDirPath, `${testName}.har`);
}

describe("mock-http-proxy", () => {
  beforeAll(async () => {
    harDirPath = await mkdtemp("/tmp/mock-http-proxy-har-");
    console.log(
      `\n=====================\nViewing HAR traces:\n\nopen ${harDirPath}\n\nThen open a new tab in Chrome and drag the .har to the Network tab of DevTools.\n=====================\n`,
    );
  });

  test("records HTTP request and response bodies", async () => {
    const harPath = harPathFor("http");

    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            path: req.url,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = getAddress(upstream);

    await using proxy = await MockEgressProxy.start({
      harRecordingPath: harPath,
    });

    const response = await fetch(`${proxy.url}/charges?ok=1`, {
      method: "POST",
      headers: {
        [TARGET_URL_HEADER]: `http://${upstreamAddress.address}:${String(upstreamAddress.port)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: 42 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      method: "POST",
      path: "/charges?ok=1",
      body: '{"amount":42}',
    });

    await proxy.writeHar();
    await closeServer(upstream);

    const har = await readHar(harPath);
    expect(har.log.entries).toHaveLength(1);

    const entry = har.log.entries[0] as {
      request: { method: string; postData?: { text: string } };
      response: { status: number; content: { text?: string } };
    };
    expect(entry.request.method).toBe("POST");
    expect(entry.request.postData?.text).toBe('{"amount":42}');
    expect(entry.response.status).toBe(200);
    expect(entry.response.content.text).toContain('"path":"/charges?ok=1"');
  });

  test("records SSE response text", async () => {
    const harPath = harPathFor("sse");

    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write("data: one\\n\\n");
      res.write("data: two\\n\\n");
      res.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = getAddress(upstream);

    await using proxy = await MockEgressProxy.start({
      harRecordingPath: harPath,
    });

    const response = await fetch(`${proxy.url}/events`, {
      headers: {
        [TARGET_URL_HEADER]: `http://${upstreamAddress.address}:${String(upstreamAddress.port)}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: one\\n\\ndata: two\\n\\n");

    await proxy.writeHar();
    await closeServer(upstream);

    const har = await readHar(harPath);
    const entry = har.log.entries[0] as {
      response: { content: { text?: string } };
    };
    expect(entry.response.content.text).toContain("data: one");
    expect(entry.response.content.text).toContain("data: two");
  });

  test("records websocket messages", async () => {
    const harPath = harPathFor("ws");

    const wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wsServer, "listening");
    wsServer.on("connection", (socket) => {
      socket.on("message", (message) => {
        socket.send(`echo:${message.toString()}`);
      });
    });

    const wsAddress = wsServer.address();
    if (!wsAddress || typeof wsAddress === "string") {
      throw new Error("expected websocket server to have a TCP address");
    }

    await using proxy = await MockEgressProxy.start({
      harRecordingPath: harPath,
    });

    const client = new WebSocket(`${proxy.url.replace("http", "ws")}/socket`, {
      headers: {
        [TARGET_URL_HEADER]: `ws://127.0.0.1:${String(wsAddress.port)}`,
      },
    });

    await once(client, "open");
    client.send("ping");

    const [message] = (await once(client, "message")) as [Buffer];
    expect(String(message)).toBe("echo:ping");

    client.close();
    await once(client, "close");

    await new Promise<void>((resolve, reject) => {
      wsServer.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await proxy.writeHar();
    const har = await readHar(harPath);
    const entry = har.log.entries[0] as {
      _webSocketMessages?: Array<{ type: string; data: string }>;
    };
    expect(entry._webSocketMessages).toBeDefined();
    expect(entry._webSocketMessages?.map((messageItem) => messageItem.type)).toEqual([
      "send",
      "receive",
    ]);
    expect(entry._webSocketMessages?.[0]?.data).toBe("ping");
    expect(entry._webSocketMessages?.[1]?.data).toBe("echo:ping");
  });

  test("applies rewriteRequest hook before resolving target", async () => {
    const harPath = harPathFor("rewrite");

    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          host: req.headers.host ?? null,
          originalHost: req.headers["x-iterate-original-host"] ?? null,
          path: req.url ?? null,
        }),
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = getAddress(upstream);

    await using proxy = await MockEgressProxy.start({
      harRecordingPath: harPath,
      rewriteRequest: ({ url, headers }) => {
        if (url !== "/v1/models") return;
        if (headers.host !== "api.openai.com.localhost") return;

        return {
          headers: {
            host: `127.0.0.1:${String(upstreamAddress.port)}`,
            "x-iterate-original-host": `127.0.0.1:${String(upstreamAddress.port)}`,
            "x-iterate-original-proto": "http",
          },
        };
      },
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = request({
        method: "GET",
        host: "127.0.0.1",
        port: proxy.port,
        path: "/v1/models",
        headers: {
          host: "api.openai.com.localhost",
        },
      });

      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      req.end();
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      host: `127.0.0.1:${String(upstreamAddress.port)}`,
      originalHost: `127.0.0.1:${String(upstreamAddress.port)}`,
      path: "/v1/models",
    });

    await proxy.writeHar();
    await closeServer(upstream);

    const har = await readHar(harPath);
    const entry = har.log.entries[0] as { request: { url: string } };
    expect(entry.request.url).toBe(`http://127.0.0.1:${String(upstreamAddress.port)}/v1/models`);
  });

  test("rejects CONNECT requests", async () => {
    const harPath = harPathFor("connect");
    await using proxy = await MockEgressProxy.start({
      harRecordingPath: harPath,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = request({
        method: "CONNECT",
        host: "127.0.0.1",
        port: proxy.port,
        path: "api.openai.com:443",
      });

      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });

      req.on("connect", (res, socket) => {
        socket.end();
        resolve({
          statusCode: res.statusCode ?? 0,
          body: "",
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.end();
    });

    expect(response.statusCode).toBe(501);

    await proxy.writeHar();
    const har = await readHar(harPath);
    expect(har.log.entries).toHaveLength(0);
  });
});
