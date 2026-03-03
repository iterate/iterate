import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { HarRecorder } from "./recorder.ts";

function harHeaderValue(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

describe("HarRecorder", () => {
  test("decodes brotli responses and sanitizes headers", async () => {
    const recorder = await HarRecorder.create({
      decodeContentEncodings: ["br"],
      sanitize: {
        requestHeaders: ["authorization"],
        responseHeaders: ["set-cookie"],
      },
    });
    const payload = JSON.stringify({ ok: true, source: "brotli" });
    const compressed = brotliCompressSync(Buffer.from(payload, "utf8"));

    recorder.appendHttpExchange(
      {
        startedAt: Date.now(),
        durationMs: 5,
        method: "POST",
        targetUrl: new URL("https://slack.com/api/auth.test"),
        requestHeaders: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        requestBody: Buffer.from('{"x":1}', "utf8"),
        response: new Response(compressed, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-encoding": "br",
            "set-cookie": "session=abc",
          },
        }),
        responseBody: compressed,
      },
      "passthrough",
    );

    const entry = recorder.getHar().log.entries[0];
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("missing entry");
    }

    expect(harHeaderValue(entry.request.headers, "authorization")).toBe("<redacted>");
    expect(harHeaderValue(entry.response.headers, "set-cookie")).toBe("<redacted>");
    expect(harHeaderValue(entry.response.headers, "content-encoding")).toBeUndefined();
    expect(entry.response.content.text).toBe(payload);
  });

  test("applies handled-request and filter controls", async () => {
    const recorder = await HarRecorder.create({
      includeHandledRequests: false,
      filter: (entry) => entry.url.hostname !== "skip.example.com",
    });

    recorder.appendHttpExchange(
      {
        startedAt: Date.now(),
        durationMs: 1,
        method: "GET",
        targetUrl: new URL("https://allowed.example.com/handled"),
        requestHeaders: {},
        requestBody: null,
        response: new Response("handled"),
        responseBody: Buffer.from("handled", "utf8"),
      },
      "handled",
    );

    recorder.appendHttpExchange(
      {
        startedAt: Date.now(),
        durationMs: 1,
        method: "GET",
        targetUrl: new URL("https://skip.example.com/passthrough"),
        requestHeaders: {},
        requestBody: null,
        response: new Response("skip"),
        responseBody: Buffer.from("skip", "utf8"),
      },
      "passthrough",
    );

    recorder.appendHttpExchange(
      {
        startedAt: Date.now(),
        durationMs: 1,
        method: "GET",
        targetUrl: new URL("https://allowed.example.com/passthrough"),
        requestHeaders: {},
        requestBody: null,
        response: new Response("ok"),
        responseBody: Buffer.from("ok", "utf8"),
      },
      "passthrough",
    );

    const urls = recorder.getHar().log.entries.map((entry) => entry.request.url);
    expect(urls).toEqual(["https://allowed.example.com/passthrough"]);
  });

  test("records websocket entries via the same filter pipeline", async () => {
    const recorder = await HarRecorder.create({
      filter: (entry) => entry.url.hostname === "api.openai.com",
      sanitize: {
        requestHeaders: ["authorization"],
      },
    });

    recorder.appendWebSocketExchange({
      startedAt: Date.now(),
      durationMs: 2,
      targetUrl: new URL("wss://api.openai.com/v1/responses"),
      requestHeaders: {
        authorization: "Bearer secret",
      },
      responseStatus: 101,
      responseStatusText: "Switching Protocols",
      responseHeaders: new Headers(),
      messages: [{ type: "send", time: Date.now() / 1000, opcode: 1, data: "ping" }],
    });

    recorder.appendWebSocketExchange({
      startedAt: Date.now(),
      durationMs: 2,
      targetUrl: new URL("wss://ignored.example.com/socket"),
      requestHeaders: {},
      responseStatus: 101,
      responseStatusText: "Switching Protocols",
      responseHeaders: new Headers(),
      messages: [{ type: "send", time: Date.now() / 1000, opcode: 1, data: "skip" }],
    });

    const entries = recorder.getHar().log.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.request.url).toBe("wss://api.openai.com/v1/responses");
    expect(harHeaderValue(entries[0]?.request.headers ?? [], "authorization")).toBe("<redacted>");
  });

  test("writes to configured harPath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mock-http-proxy-recorder-test-"));
    const harPath = join(dir, "recorded.har");
    const recorder = await HarRecorder.create({ harPath });

    recorder.appendHttpExchange(
      {
        startedAt: Date.now(),
        durationMs: 1,
        method: "GET",
        targetUrl: new URL("https://example.com/"),
        requestHeaders: {},
        requestBody: null,
        response: new Response("ok"),
        responseBody: Buffer.from("ok", "utf8"),
      },
      "passthrough",
    );
    await recorder.writeConfiguredIfAny();

    const parsed = JSON.parse(await readFile(harPath, "utf8")) as {
      log: { entries: Array<{ request: { url: string } }> };
    };
    expect(parsed.log.entries.map((entry) => entry.request.url)).toEqual(["https://example.com/"]);
  });
});
