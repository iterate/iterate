import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { http, HttpResponse, passthrough } from "msw";
import { describe, expect, test } from "vitest";
import { useMockHttpServer, useTemporaryDirectory } from "./test-helpers.ts";

describe("useMockHttpServer", () => {
  // We intentionally use temp folders + HAR paths in tests so failures leave
  // inspectable HAR logs behind for debugging request/response behavior.
  test("matches MSW handlers after proxy URL rewriting", async () => {
    await using server = await useMockHttpServer({
      handlers: [
        http.get("https://api.example.com/users", () => {
          return HttpResponse.json([{ id: 1, name: "Alice" }]);
        }),
      ],
    });

    const response = await fetch(`${server.url}/users`, {
      headers: {
        "x-iterate-original-host": "api.example.com",
        "x-iterate-original-proto": "https",
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([{ id: 1, name: "Alice" }]);
  });

  test("matches via x-iterate-target-url header", async () => {
    await using server = await useMockHttpServer({
      handlers: [
        http.post("https://api.example.com/data", async ({ request }) => {
          const body = await request.json();
          return HttpResponse.json({ received: body });
        }),
      ],
    });

    const response = await fetch(`${server.url}/data`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-iterate-target-url": "https://api.example.com",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ received: { hello: "world" } });
  });

  test("errors on unhandled requests by default (no HAR)", async () => {
    await using server = await useMockHttpServer({
      handlers: [
        http.get("https://api.example.com/known", () => {
          return HttpResponse.json({ ok: true });
        }),
      ],
    });

    const response = await fetch(`${server.url}/unknown`, {
      headers: {
        "x-iterate-original-host": "api.example.com",
        "x-iterate-original-proto": "https",
      },
    });

    expect(response.status).toBe(500);
  });

  test("runtime handler override via .use()", async () => {
    await using server = await useMockHttpServer({
      handlers: [
        http.get("https://api.example.com/data", () => {
          return HttpResponse.json({ version: 1 });
        }),
      ],
    });

    const headers = {
      "x-iterate-original-host": "api.example.com",
      "x-iterate-original-proto": "https",
    };

    const r1 = await fetch(`${server.url}/data`, { headers });
    expect(await r1.json()).toEqual({ version: 1 });

    server.use(
      http.get("https://api.example.com/data", () => {
        return HttpResponse.json({ version: 2 });
      }),
    );

    const r2 = await fetch(`${server.url}/data`, { headers });
    expect(await r2.json()).toEqual({ version: 2 });

    server.resetHandlers();

    const r3 = await fetch(`${server.url}/data`, { headers });
    expect(await r3.json()).toEqual({ version: 1 });
  });

  test("records HAR when mode=record", async () => {
    using tmpDir = useTemporaryDirectory();
    const harPath = join(tmpDir.path, "test.har");

    await using server = await useMockHttpServer({
      harPath,
      mode: "record",
    });

    const response = await fetch(`${server.url}/`, {
      headers: {
        "x-iterate-original-host": "example.com",
        "x-iterate-original-proto": "http",
      },
    });
    expect(response.status).toBeGreaterThanOrEqual(200);

    const har = server.getHar();
    expect(har.log.entries.length).toBeGreaterThanOrEqual(1);
    expect(har.log.entries[0]!.request.url).toContain("http://example.com/");
  });

  test("strips proxy headers from rewritten request", async () => {
    let capturedHeaders: Headers | undefined;
    await using server = await useMockHttpServer({
      handlers: [
        http.get("https://api.example.com/inspect", ({ request }) => {
          capturedHeaders = request.headers;
          return HttpResponse.json({ ok: true });
        }),
      ],
    });

    await fetch(`${server.url}/inspect`, {
      headers: {
        "x-iterate-target-url": "https://api.example.com",
        "x-iterate-original-host": "api.example.com",
        "x-iterate-original-proto": "https",
        authorization: "Bearer test-token",
      },
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get("x-iterate-target-url")).toBeNull();
    expect(capturedHeaders!.get("x-iterate-original-host")).toBeNull();
    expect(capturedHeaders!.get("x-iterate-original-proto")).toBeNull();
    expect(capturedHeaders!.get("authorization")).toBe("Bearer test-token");
  });

  test("records requests handled by MSW handlers by default", async () => {
    using tmpDir = useTemporaryDirectory();
    const harPath = join(tmpDir.path, "records-matched-handler.har");

    await using server = await useMockHttpServer({
      harPath,
      handlers: [
        http.get("https://api.example.com/hello", () => {
          return HttpResponse.json({ mocked: true });
        }),
      ],
    });

    const response = await fetch(`${server.url}/hello`, {
      headers: {
        "x-iterate-original-host": "api.example.com",
        "x-iterate-original-proto": "https",
      },
    });
    expect(response.status).toBe(200);

    const har = server.getHar();
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]?.request.url).toBe("https://api.example.com/hello");
  });

  test("can disable recording requests handled by MSW handlers", async () => {
    using tmpDir = useTemporaryDirectory();
    const harPath = join(tmpDir.path, "does-not-record-matched-handler.har");

    await using server = await useMockHttpServer({
      harPath,
      recordHandledRequests: false,
      handlers: [
        http.get("https://api.example.com/hello", () => {
          return HttpResponse.json({ mocked: true });
        }),
      ],
    });

    const response = await fetch(`${server.url}/hello`, {
      headers: {
        "x-iterate-original-host": "api.example.com",
        "x-iterate-original-proto": "https",
      },
    });
    expect(response.status).toBe(200);
    expect(server.getHar().log.entries).toHaveLength(0);
  });

  test("bypass passthrough works for public HTTP endpoint", async () => {
    using tmpDir = useTemporaryDirectory();
    const harPath = join(tmpDir.path, "public-http-passthrough.har");

    await using server = await useMockHttpServer({
      harPath,
      mode: "record",
    });

    const response = await fetch(`${server.url}/`, {
      headers: {
        "x-iterate-target-url": "https://example.com",
      },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body.toLowerCase()).toContain("example domain");
    expect(
      server.getHar().log.entries.some((entry) => entry.request.url.includes("example.com")),
    ).toBe(true);
  }, 20_000);

  test("msw passthrough() works for HTTP", async () => {
    using tmpDir = useTemporaryDirectory();
    const harPath = join(tmpDir.path, "msw-passthrough-http.har");

    await using server = await useMockHttpServer({
      harPath,
      mode: "record",
      handlers: [
        http.get("https://example.com/", () => {
          return passthrough();
        }),
      ],
    });

    const response = await fetch(`${server.url}/`, {
      headers: {
        "x-iterate-target-url": "https://example.com",
      },
    });
    expect(response.status).toBe(200);
    const har = server.getHar();
    expect(har.log.entries.length).toBeGreaterThanOrEqual(1);
    expect(har.log.entries.some((entry) => entry.request.url.includes("example.com"))).toBe(true);
  }, 20_000);

  test("passthrough works for SSE endpoint", async () => {
    using tmpDir = useTemporaryDirectory();
    const harPath = join(tmpDir.path, "public-sse-passthrough.har");

    await using server = await useMockHttpServer({
      harPath,
      mode: "record",
    });

    const response = await fetch(`${server.url}/test?interval=1`, {
      headers: {
        "x-iterate-target-url": "https://sse.dev",
      },
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.toLowerCase()).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let chunkText = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !chunkText.includes("data:")) {
      const { done, value } = await reader!.read();
      if (done) break;
      chunkText += decoder.decode(value, { stream: true });
    }
    await reader?.cancel();
    expect(chunkText).toContain("data:");
  }, 30_000);

  test("passthrough works for websocket echo endpoint", async () => {
    using tmpDir = useTemporaryDirectory();
    const harPath = join(tmpDir.path, "public-websocket-passthrough.har");

    await using server = await useMockHttpServer({
      harPath,
      mode: "record",
    });

    const wsUrl = new URL(server.url);
    wsUrl.protocol = "ws:";
    wsUrl.pathname = "/raw";

    const payload = `echo-${randomUUID()}`;
    const echoedPayload = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(wsUrl.toString(), {
        headers: {
          "x-iterate-target-url": "wss://ws.postman-echo.com",
        },
      });

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("websocket echo timeout"));
      }, 15_000);

      socket.on("open", () => {
        socket.send(payload);
      });
      socket.on("message", (data) => {
        clearTimeout(timeout);
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        socket.close();
        resolve(text);
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(echoedPayload).toBe(payload);
  }, 30_000);
});
