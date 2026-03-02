import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { HttpResponse, http } from "msw";
import { MockMswHttpProxy, type Har } from "../src/index.ts";

function createHarEntry(params: {
  method: string;
  url: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  requestBodyText?: string;
  requestMimeType?: string;
  status: number;
  statusText: string;
  responseHeaders?: Array<{ name: string; value: string }>;
  responseBodyText: string;
  responseMimeType?: string;
}) {
  return {
    startedDateTime: new Date().toISOString(),
    time: 1,
    request: {
      method: params.method,
      url: params.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: params.requestHeaders ?? [],
      queryString: Array.from(new URL(params.url).searchParams.entries()).map(([name, value]) => ({
        name,
        value,
      })),
      headersSize: -1,
      bodySize: params.requestBodyText ? Buffer.byteLength(params.requestBodyText) : 0,
      ...(params.requestBodyText
        ? {
            postData: {
              mimeType: params.requestMimeType ?? "application/json",
              text: params.requestBodyText,
            },
          }
        : {}),
    },
    response: {
      status: params.status,
      statusText: params.statusText,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: params.responseHeaders ?? [{ name: "content-type", value: "application/json" }],
      content: {
        size: Buffer.byteLength(params.responseBodyText),
        mimeType: params.responseMimeType ?? "application/json",
        text: params.responseBodyText,
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: Buffer.byteLength(params.responseBodyText),
    },
    cache: {},
    timings: {
      send: 0,
      wait: 0,
      receive: 0,
    },
  };
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

describe("MockMswHttpProxy", () => {
  test("records HAR while passthroughing to a real upstream server", async () => {
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            source: "upstream",
            method: req.method,
            path: req.url,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");

    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("expected upstream server address");
    }

    const harDir = await mkdtemp(join(tmpdir(), "mock-msw-http-proxy-record-"));
    const harPath = join(harDir, "record.har");

    await using proxy = await MockMswHttpProxy.start({
      mode: "record",
      harRecordingPath: harPath,
    });

    const response = await fetch(`${proxy.url}/v1/models?limit=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-iterate-target-url": `http://127.0.0.1:${String(upstreamAddress.port)}`,
      },
      body: JSON.stringify({ q: "hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      source: "upstream",
      method: "POST",
      path: "/v1/models?limit=1",
      body: '{"q":"hello"}',
    });

    const inMemoryHar = proxy.getHar();
    expect(inMemoryHar.log.entries).toHaveLength(1);
    expect(inMemoryHar.log.entries[0]?.request.url).toBe(
      `http://127.0.0.1:${String(upstreamAddress.port)}/v1/models?limit=1`,
    );

    await proxy.writeHar();
    const persisted = JSON.parse(await readFile(harPath, "utf8")) as Har;
    expect(persisted.log.entries).toHaveLength(1);

    await closeServer(upstream);
  });

  test("replays responses from HAR without upstream network access", async () => {
    const replayHar: Har = {
      log: {
        version: "1.2",
        creator: { name: "test", version: "1" },
        entries: [
          createHarEntry({
            method: "GET",
            url: "https://api.example.com/v1/models?limit=1",
            status: 200,
            statusText: "OK",
            responseBodyText: JSON.stringify({ source: "har", ok: true }),
          }),
        ],
      },
    };

    const harDir = await mkdtemp(join(tmpdir(), "mock-msw-http-proxy-replay-"));
    const replayPath = join(harDir, "replay.har");
    await writeFile(replayPath, `${JSON.stringify(replayHar, null, 2)}\n`, "utf8");

    await using proxy = await MockMswHttpProxy.start({
      mode: "replay",
      replayFromHar: replayPath,
    });

    const response = await fetch(`${proxy.url}/v1/models?limit=1`, {
      headers: {
        "x-iterate-target-url": "https://api.example.com",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: "har", ok: true });
  });

  test("supports custom MSW handlers layered with replay-or-record fallback", async () => {
    const replayHar: Har = {
      log: {
        version: "1.2",
        creator: { name: "test", version: "1" },
        entries: [
          createHarEntry({
            method: "GET",
            url: "https://api.example.com/from-har",
            status: 200,
            statusText: "OK",
            responseBodyText: JSON.stringify({ source: "har" }),
          }),
        ],
      },
    };

    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ source: "live" }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");

    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("expected upstream server address");
    }

    await using proxy = await MockMswHttpProxy.start({
      mode: "replay-or-record",
      replayFromHar: replayHar,
      handlers: [
        http.get("/custom", () => {
          return HttpResponse.json({ source: "custom" });
        }),
      ],
    });

    const customResponse = await fetch(`${proxy.url}/custom`);
    expect(customResponse.status).toBe(200);
    await expect(customResponse.json()).resolves.toEqual({ source: "custom" });

    const replayResponse = await fetch(`${proxy.url}/from-har`, {
      headers: {
        "x-iterate-target-url": "https://api.example.com",
      },
    });
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toEqual({ source: "har" });

    const liveResponse = await fetch(`${proxy.url}/from-live`, {
      headers: {
        "x-iterate-target-url": `http://127.0.0.1:${String(upstreamAddress.port)}`,
      },
    });
    expect(liveResponse.status).toBe(200);
    await expect(liveResponse.json()).resolves.toEqual({ source: "live" });

    const har = proxy.getHar();
    expect(
      har.log.entries.some(
        (entry) =>
          entry.request.url === `http://127.0.0.1:${String(upstreamAddress.port)}/from-live`,
      ),
    ).toBe(true);

    await closeServer(upstream);
  });
});
