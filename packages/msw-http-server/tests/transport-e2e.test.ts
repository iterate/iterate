import { once } from "node:events";
import { Agent, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { HttpResponse, http, ws } from "msw";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import { createNativeMswServer, type NativeMswServer } from "../src/index.ts";

const activeServers = new Set<NativeMswServer>();
const activeWebSocketServers = new Set<WebSocketServer>();

async function listen(server: NativeMswServer): Promise<{ baseUrl: string; port: number }> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  activeServers.add(server);
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
  };
}

async function close(server: NativeMswServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  activeServers.delete(server);
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
  activeWebSocketServers.delete(server);
}

async function requestWithAgent(
  url: string,
  agent: Agent,
): Promise<{ status: number; body: string; reusedSocket: boolean }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", agent });

    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          reusedSocket: req.reusedSocket,
        });
      });
    });

    req.end();
  });
}

afterEach(async () => {
  for (const webSocketServer of activeWebSocketServers) {
    await closeWebSocketServer(webSocketServer);
  }

  for (const server of activeServers) {
    await close(server);
  }
});

describe("native transport e2e", () => {
  test("supports SSE-style streaming responses", async () => {
    const encoder = new TextEncoder();
    const server = createNativeMswServer(
      http.get("/events", () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\ndata: first\n\n"));
            setTimeout(() => {
              controller.enqueue(encoder.encode("event: message\ndata: second\n\n"));
              controller.close();
            }, 10);
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }),
    );

    const { baseUrl } = await listen(server);
    const response = await fetch(`${baseUrl}/events`, {
      headers: {
        accept: "text/event-stream",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();

    const decoder = new TextDecoder();
    let payload = "";
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      payload += decoder.decode(value, { stream: true });
    }

    payload += decoder.decode();

    expect(payload).toContain("data: first");
    expect(payload).toContain("data: second");
  });

  test("supports file uploads and multipart form parsing", async () => {
    const server = createNativeMswServer(
      http.post("/upload", async ({ request }) => {
        const formData = await request.formData();
        const filePart = formData.get("file");
        const labels = formData.getAll("label").map(String);

        if (!(filePart instanceof File)) {
          return HttpResponse.json({ error: "missing file" }, { status: 400 });
        }

        return HttpResponse.json({
          labels,
          fileName: filePart.name,
          fileType: filePart.type,
          fileText: await filePart.text(),
        });
      }),
    );

    const { baseUrl } = await listen(server);
    const formData = new FormData();
    formData.append("label", "alpha");
    formData.append("label", "beta");
    formData.append("file", new Blob(["hello world"], { type: "text/plain" }), "hello.txt");

    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      labels: ["alpha", "beta"],
      fileName: "hello.txt",
      fileType: "text/plain",
      fileText: "hello world",
    });
  });

  test("reuses sockets with keep-alive clients", async () => {
    const server = createNativeMswServer(
      http.get("/keep-alive", () => {
        return HttpResponse.text("ok");
      }),
    );

    let connectionCount = 0;
    server.on("connection", () => {
      connectionCount += 1;
    });

    const { baseUrl } = await listen(server);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    try {
      const first = await requestWithAgent(`${baseUrl}/keep-alive`, agent);
      const second = await requestWithAgent(`${baseUrl}/keep-alive`, agent);

      expect(first.status).toBe(200);
      expect(first.body).toBe("ok");
      expect(second.status).toBe(200);
      expect(second.body).toBe("ok");
      expect(second.reusedSocket).toBe(true);
      expect(connectionCount).toBe(1);
    } finally {
      agent.destroy();
    }
  });

  test("supports native websocket upgrades on the same server", async () => {
    const server = createNativeMswServer(
      http.get("/health", () => {
        return HttpResponse.text("ok");
      }),
    );
    const webSocketServer = new WebSocketServer({ noServer: true });
    activeWebSocketServers.add(webSocketServer);

    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/socket") {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (client: WebSocket) => {
        webSocketServer.emit("connection", client, request);
      });
    });

    webSocketServer.on("connection", (client: WebSocket) => {
      client.send("hello");
      client.close();
    });

    const { port } = await listen(server);

    const message = await new Promise<string>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${String(port)}/socket`);
      const timeout = setTimeout(() => {
        client.terminate();
        reject(new Error("Timed out waiting for websocket message"));
      }, 500);

      client.once("message", (data: RawData) => {
        clearTimeout(timeout);
        resolve(data.toString());
        client.close();
      });

      client.once("error", (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(message).toBe("hello");
  });

  test("applies MSW ws handlers on native upgrade flow", async () => {
    let connectionHandled = false;
    const chat = ws.link("/socket");
    const wsHandler = chat.addEventListener("connection", ({ client }) => {
      connectionHandled = true;
      client.send("hello-from-handler");
      client.addEventListener("message", (event) => {
        if (event.data === "ping") {
          client.send("pong");
        }
      });
    });

    const server = createNativeMswServer(wsHandler);
    const { port } = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/socket`);
    const messages: string[] = [];
    client.on("message", (data: RawData) => {
      messages.push(data.toString());
    });
    const openOutcome = await new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        resolve("timeout");
      }, 1_000);

      client.once("open", () => {
        clearTimeout(timeout);
        resolve("open");
      });
      client.once("close", () => {
        clearTimeout(timeout);
        resolve("close");
      });
      client.once("error", () => {
        clearTimeout(timeout);
        resolve("error");
      });
    });
    expect(openOutcome).toBe("open");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for first websocket message"));
      }, 1_000);
      const interval = setInterval(() => {
        if (messages.length >= 1) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 5);
      client.once("error", reject);
    });
    expect(messages[0]).toBe("hello-from-handler");

    const secondMessagePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for second websocket message"));
      }, 1_000);
      const interval = setInterval(() => {
        if (messages.length >= 2) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 5);
      client.once("error", reject);
    });
    client.send("ping");
    await secondMessagePromise;
    expect(messages[1]).toBe("pong");

    client.close();
    await once(client, "close");

    expect(connectionHandled).toBe(true);
  });
});
