import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import httpProxy from "http-proxy";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Har, HarEntry } from "./har-types.ts";

const TARGET_URL_HEADER = "x-iterate-target-url";
const LEGACY_TARGET_URL_HEADER = "x-target-url";
const ORIGINAL_HOST_HEADER = "x-iterate-original-host";
const LEGACY_ORIGINAL_HOST_HEADER = "x-original-host";
const ORIGINAL_PROTO_HEADER = "x-iterate-original-proto";
const LEGACY_ORIGINAL_PROTO_HEADER = "x-original-proto";
const TARGET_PATH_PREFIX = "/__iterate_target__/";

type ProtocolKind = "http" | "ws";

type PendingHttpRequest = {
  startedAt: number;
  entry: HarEntry;
  response: ServerResponse;
};

export type MockEgressProxyRequestRewriteInput = {
  protocolKind: ProtocolKind;
  method: string;
  url: string;
  headers: Record<string, string>;
};

export type MockEgressProxyRequestRewriteResult = {
  url?: string;
  headers?: Record<string, string | undefined>;
};

export type MockEgressProxyRequestRewrite = (
  input: MockEgressProxyRequestRewriteInput,
) => MockEgressProxyRequestRewriteResult | void;

export interface MockEgressProxyListenOptions {
  harRecordingPath: string;
  port?: number;
  host?: string;
  rewriteRequest?: MockEgressProxyRequestRewrite;
}

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function normalizeProtocol(url: URL, protocolKind: ProtocolKind): URL {
  if (protocolKind === "ws") {
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url;
  }

  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url;
}

function mapHeaders(headers: IncomingMessage["headers"]): Array<{ name: string; value: string }> {
  const mapped: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    mapped.push({ name, value: Array.isArray(value) ? value.join(", ") : value });
  }
  return mapped;
}

function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flattened[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flattened;
}

function applyRequestRewrite(
  req: IncomingMessage,
  protocolKind: ProtocolKind,
  rewriteRequest: MockEgressProxyRequestRewrite | undefined,
): void {
  if (!rewriteRequest) return;

  const output = rewriteRequest({
    protocolKind,
    method: req.method ?? "GET",
    url: req.url ?? "/",
    headers: flattenHeaders(req.headers),
  });
  if (!output) return;

  if (output.url !== undefined) {
    req.url = output.url;
  }

  if (!output.headers) return;
  for (const [name, value] of Object.entries(output.headers)) {
    const normalizedName = name.toLowerCase();
    if (value === undefined) {
      delete req.headers[normalizedName];
      continue;
    }
    req.headers[normalizedName] = value;
  }
}

function shouldTreatAsText(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((chunk) => toBuffer(chunk)));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error("unsupported websocket data shape");
}

function wsMessageData(data: RawData, isBinary: boolean): string {
  const buffer = toBuffer(data);
  return isBinary ? buffer.toString("base64") : buffer.toString("utf8");
}

function buildUpstreamWebSocketHeaders(req: IncomingMessage): Record<string, string> {
  const excluded = new Set([
    "host",
    "connection",
    "upgrade",
    "proxy-connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    TARGET_URL_HEADER,
    LEGACY_TARGET_URL_HEADER,
  ]);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (excluded.has(name)) continue;
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  return headers;
}

function webSocketProtocolsFromRequest(req: IncomingMessage): string[] {
  const raw = firstHeader(req.headers["sec-websocket-protocol"]);
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function createHarEntry(req: IncomingMessage, url: URL): HarEntry {
  return {
    startedDateTime: new Date().toISOString(),
    time: 0,
    request: {
      method: req.method ?? "GET",
      url: url.toString(),
      httpVersion: `HTTP/${req.httpVersion}`,
      cookies: [],
      headers: mapHeaders(req.headers),
      queryString: Array.from(url.searchParams.entries()).map(([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: {
        size: 0,
        mimeType: "application/octet-stream",
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: {
      send: 0,
      wait: 0,
      receive: 0,
    },
  };
}

function targetFromEncodedPath(rawUrl: string, protocolKind: ProtocolKind): URL | null {
  const parsed = new URL(rawUrl, "http://mock-http-proxy.local");
  if (!parsed.pathname.startsWith(TARGET_PATH_PREFIX)) return null;

  const rest = parsed.pathname.slice(TARGET_PATH_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0) return null;

  const encodedBase = rest.slice(0, slashIndex);
  const base = normalizeProtocol(new URL(decodeURIComponent(encodedBase)), protocolKind);

  const relativePath = rest.slice(slashIndex);
  return normalizeProtocol(new URL(`${relativePath}${parsed.search}`, base), protocolKind);
}

function resolveTarget(req: IncomingMessage, protocolKind: ProtocolKind): URL | null {
  const headerTarget =
    firstHeader(req.headers[TARGET_URL_HEADER]) ||
    firstHeader(req.headers[LEGACY_TARGET_URL_HEADER]);
  const rawUrl = req.url ?? "/";

  const pathTarget = targetFromEncodedPath(rawUrl, protocolKind);
  if (pathTarget) return pathTarget;

  if (headerTarget) {
    const base = normalizeProtocol(new URL(headerTarget), protocolKind);
    return normalizeProtocol(new URL(rawUrl, base), protocolKind);
  }

  if (/^https?:\/\//i.test(rawUrl) || /^wss?:\/\//i.test(rawUrl)) {
    return normalizeProtocol(new URL(rawUrl), protocolKind);
  }

  const host =
    firstHeader(req.headers[ORIGINAL_HOST_HEADER]) ||
    firstHeader(req.headers[LEGACY_ORIGINAL_HOST_HEADER]) ||
    firstHeader(req.headers.host);
  if (!host) return null;
  const forwardedProto =
    firstHeader(req.headers[ORIGINAL_PROTO_HEADER]) ||
    firstHeader(req.headers[LEGACY_ORIGINAL_PROTO_HEADER]) ||
    firstHeader(req.headers["x-forwarded-proto"]);
  const normalizedProto = forwardedProto.toLowerCase();

  let scheme = protocolKind === "ws" ? "wss" : "http";
  if (protocolKind === "ws") {
    scheme = normalizedProto === "http" || normalizedProto === "ws" ? "ws" : "wss";
  } else {
    scheme = normalizedProto === "https" || normalizedProto === "wss" ? "https" : "http";
  }

  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return new URL(`${scheme}://${host}${path}`);
}

function setPostDataFromRequest(req: IncomingMessage, entry: HarEntry): void {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return;

  const chunks: Buffer[] = [];
  req.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on("end", () => {
    if (chunks.length === 0) return;
    const body = Buffer.concat(chunks);
    const mimeType = firstHeader(req.headers["content-type"]) || "application/octet-stream";
    const asText = shouldTreatAsText(mimeType);

    entry.request.postData = {
      mimeType,
      text: asText ? body.toString("utf8") : body.toString("base64"),
    };
    entry.request.bodySize = body.length;
  });
}

function writeConnectUnsupported(socket: NodeJS.WritableStream): void {
  const body =
    "CONNECT is not supported by mock-http-proxy v1. This proxy expects traffic to be decrypted before it reaches this process.";
  socket.write(
    "HTTP/1.1 501 Not Implemented\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
}

export class MockEgressProxy implements AsyncDisposable {
  private readonly har: Har = {
    log: {
      version: "1.2",
      creator: { name: "@iterate-com/mock-http-proxy", version: "0.0.1" },
      entries: [],
    },
  };

  private server: Server | undefined;
  private readonly proxy = httpProxy.createProxyServer({ xfwd: true, secure: false });
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly pendingHttp = new WeakMap<IncomingMessage, PendingHttpRequest>();
  private closePromise: Promise<void> | undefined;
  private started = false;
  private harRecordingPath = "";

  public port = 0;
  public url = "";

  constructor() {
    this.proxy.on("proxyRes", (proxyRes, req, res) => {
      const incoming = req as IncomingMessage;
      const pending = this.pendingHttp.get(incoming);
      if (!pending) return;

      const bodyChunks: Buffer[] = [];
      proxyRes.on("data", (chunk) => {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      proxyRes.on("end", () => {
        const body = Buffer.concat(bodyChunks);
        const mimeType = String(proxyRes.headers["content-type"] ?? "application/octet-stream");
        const asText = shouldTreatAsText(mimeType);

        pending.entry.response.status = proxyRes.statusCode ?? 0;
        pending.entry.response.statusText = proxyRes.statusMessage ?? "";
        pending.entry.response.headers = Object.entries(proxyRes.headers)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({
            name,
            value: Array.isArray(value) ? value.join(", ") : String(value),
          }));
        pending.entry.response.content.mimeType = mimeType;
        pending.entry.response.content.size = body.length;
        pending.entry.response.content.text = asText
          ? body.toString("utf8")
          : body.toString("base64");
        if (!asText) pending.entry.response.content.encoding = "base64";
        pending.entry.response.bodySize = body.length;
        pending.entry.time = Date.now() - pending.startedAt;

        pending.response.writeHead(
          proxyRes.statusCode ?? 502,
          proxyRes.statusMessage,
          proxyRes.headers,
        );
        pending.response.end(body);

        this.har.log.entries.push(pending.entry);
        this.pendingHttp.delete(incoming);
      });

      proxyRes.on("error", () => {
        if (!pending.response.headersSent) {
          pending.response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        }
        pending.response.end("proxy response stream error");
        pending.entry.time = Date.now() - pending.startedAt;
        this.har.log.entries.push(pending.entry);
        this.pendingHttp.delete(incoming);
      });

      void res;
    });
  }

  static async start(options: MockEgressProxyListenOptions): Promise<MockEgressProxy> {
    const proxy = new MockEgressProxy();
    await proxy.listen(options);
    return proxy;
  }

  async listen(options: MockEgressProxyListenOptions): Promise<void> {
    if (this.started) {
      throw new Error("MockEgressProxy.listen() called more than once");
    }

    this.started = true;
    this.harRecordingPath = options.harRecordingPath;

    this.server = createServer((req, res) => {
      if ((req.method ?? "").toUpperCase() === "CONNECT") {
        res.writeHead(501, { "content-type": "text/plain; charset=utf-8" });
        res.end(
          "CONNECT is not supported by mock-http-proxy v1. This proxy expects traffic to be decrypted before it reaches this process.",
        );
        return;
      }

      try {
        applyRequestRewrite(req, "http", options.rewriteRequest);
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: "rewrite_request_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }

      const targetUrl = resolveTarget(req, "http");
      if (!targetUrl) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "missing_target" }));
        return;
      }

      const entry = createHarEntry(req, targetUrl);
      const startedAt = Date.now();
      setPostDataFromRequest(req, entry);

      req.url = `${targetUrl.pathname}${targetUrl.search}`;
      req.headers.host = targetUrl.host;
      this.pendingHttp.set(req, {
        startedAt,
        entry,
        response: res,
      });

      this.proxy.web(
        req,
        res,
        {
          target: `${targetUrl.protocol}//${targetUrl.host}`,
          changeOrigin: true,
          selfHandleResponse: true,
        },
        () => {
          const pending = this.pendingHttp.get(req);
          if (!pending) return;
          if (!pending.response.headersSent) {
            pending.response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
          }
          pending.response.end(JSON.stringify({ error: "proxy_error" }));
          pending.entry.time = Date.now() - pending.startedAt;
          this.har.log.entries.push(pending.entry);
          this.pendingHttp.delete(req);
        },
      );
    });

    this.server.on("connect", (_req, socket) => {
      writeConnectUnsupported(socket);
      socket.destroy();
    });

    this.server.on("upgrade", (req, socket, head) => {
      try {
        applyRequestRewrite(req, "ws", options.rewriteRequest);
      } catch (error) {
        socket.write(
          `HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({
            error: "rewrite_request_failed",
            message: error instanceof Error ? error.message : String(error),
          })}`,
        );
        socket.destroy();
        return;
      }

      const targetUrl = resolveTarget(req, "ws");
      if (!targetUrl) {
        socket.write(
          'HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\r\n{"error":"missing_target"}',
        );
        socket.destroy();
        return;
      }

      const entry = createHarEntry(req, targetUrl);
      entry.response.status = 101;
      entry.response.statusText = "Switching Protocols";
      entry.response.content.mimeType = "x-application/websocket";
      entry._webSocketMessages = [];
      this.har.log.entries.push(entry);
      const startedAt = Date.now();

      this.wss.handleUpgrade(req, socket, head, (clientWs) => {
        const upstreamHeaders = buildUpstreamWebSocketHeaders(req);
        const upstreamProtocols = webSocketProtocolsFromRequest(req);
        const upstreamWs =
          upstreamProtocols.length > 0
            ? new WebSocket(targetUrl.toString(), upstreamProtocols, { headers: upstreamHeaders })
            : new WebSocket(targetUrl.toString(), { headers: upstreamHeaders });

        const queuedClientMessages: Array<{ data: RawData; isBinary: boolean }> = [];
        let done = false;

        const finalize = () => {
          if (done) return;
          done = true;
          entry.time = Date.now() - startedAt;
        };

        upstreamWs.on("upgrade", (response) => {
          entry.response.headers = Object.entries(response.headers)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => ({
              name,
              value: Array.isArray(value) ? value.join(", ") : String(value),
            }));
        });

        clientWs.on("message", (data, isBinary) => {
          entry._webSocketMessages?.push({
            type: "send",
            time: Date.now() / 1000,
            opcode: isBinary ? 2 : 1,
            data: wsMessageData(data, isBinary),
          });

          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(data, { binary: isBinary });
            return;
          }

          queuedClientMessages.push({ data, isBinary });
        });

        upstreamWs.on("open", () => {
          for (const queued of queuedClientMessages) {
            upstreamWs.send(queued.data, { binary: queued.isBinary });
          }
          queuedClientMessages.length = 0;
        });

        upstreamWs.on("message", (data, isBinary) => {
          entry._webSocketMessages?.push({
            type: "receive",
            time: Date.now() / 1000,
            opcode: isBinary ? 2 : 1,
            data: wsMessageData(data, isBinary),
          });
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        });

        clientWs.on("close", () => {
          finalize();
          if (
            upstreamWs.readyState === WebSocket.OPEN ||
            upstreamWs.readyState === WebSocket.CONNECTING
          ) {
            upstreamWs.close();
          }
        });

        upstreamWs.on("close", () => {
          finalize();
          if (
            clientWs.readyState === WebSocket.OPEN ||
            clientWs.readyState === WebSocket.CONNECTING
          ) {
            clientWs.close();
          }
        });

        clientWs.on("error", () => {
          finalize();
          if (
            upstreamWs.readyState === WebSocket.OPEN ||
            upstreamWs.readyState === WebSocket.CONNECTING
          ) {
            upstreamWs.close();
          }
        });

        upstreamWs.on("error", () => {
          finalize();
          if (
            clientWs.readyState === WebSocket.OPEN ||
            clientWs.readyState === WebSocket.CONNECTING
          ) {
            clientWs.close();
          }
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
    });

    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("mock-http-proxy failed to bind to TCP port");
    }

    this.port = (address as AddressInfo).port;
    const host = options.host ?? "127.0.0.1";
    this.url = `http://${host}:${String(this.port)}`;
  }

  getHar(): Har {
    return JSON.parse(JSON.stringify(this.har)) as Har;
  }

  async writeHar(path = this.harRecordingPath): Promise<void> {
    if (!path) {
      throw new Error("harRecordingPath is not configured");
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(this.har, null, 2)}\n`, "utf8");
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;

    this.closePromise = (async () => {
      this.proxy.close();
      this.wss.close();

      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server?.close(() => resolve());
        });
      }

      await this.writeHar().catch(() => {});
    })();

    await this.closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
