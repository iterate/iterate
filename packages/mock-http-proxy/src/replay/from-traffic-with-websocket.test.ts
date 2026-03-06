import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, test } from "vitest";
import type { HarEntryWithExtensions, HarWithExtensions } from "../har/har-extensions.ts";
import { useMockHttpServer } from "../server/mock-http-server-fixture.ts";
import { fromTrafficWithWebSocket } from "./from-traffic-with-websocket.ts";

function baseEntry(): Omit<HarEntryWithExtensions, "request" | "response"> {
  return {
    startedDateTime: new Date().toISOString(),
    time: 1,
    cache: {},
    timings: {
      send: 0,
      wait: 0,
      receive: 0,
    },
  };
}

function createArchive(): HarWithExtensions {
  return {
    log: {
      version: "1.2",
      creator: { name: "test", version: "1.0.0" },
      entries: [
        {
          ...baseEntry(),
          request: {
            method: "GET",
            url: "https://api.example.com/hello",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            queryString: [],
            headersSize: -1,
            bodySize: 0,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [{ name: "content-type", value: "application/json; charset=utf-8" }],
            content: {
              size: 20,
              mimeType: "application/json; charset=utf-8",
              text: '{"message":"hello"}',
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: 20,
          },
        },
        {
          ...baseEntry(),
          request: {
            method: "GET",
            url: "wss://socket.example.com/chat",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            queryString: [],
            headersSize: -1,
            bodySize: 0,
          },
          response: {
            status: 101,
            statusText: "Switching Protocols",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            content: {
              size: 0,
              mimeType: "x-application/websocket",
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: 0,
          },
          _resourceType: "websocket",
          _webSocketMessages: [
            { type: "send", time: Date.now() / 1000, opcode: 1, data: "ping" },
            { type: "receive", time: Date.now() / 1000, opcode: 1, data: "pong" },
          ],
        },
      ],
    },
  };
}

describe("fromTrafficWithWebSocket", () => {
  test("replays HTTP and websocket from HAR without endpoint-specific logic", async () => {
    const archive = createArchive();
    const handlers = fromTrafficWithWebSocket(archive, {
      matchWebSocketBy: "path",
      strictSendMatch: true,
    });
    await using server = await useMockHttpServer({
      onUnhandledRequest: "error",
    });
    server.use(...handlers);

    const httpResponse = await fetch(`${server.url}/hello`, {
      headers: {
        "x-forwarded-host": "api.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toEqual({ message: "hello" });

    const client = new WebSocket(`ws://127.0.0.1:${String(server.port)}/chat`);
    await once(client, "open");

    client.send("ping");
    const [raw] = (await once(client, "message")) as [Buffer];
    expect(raw.toString()).toBe("pong");

    client.close();
    await once(client, "close");
  });
});
