import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  createNativeMswServer,
  type NativeMswServer,
  type TransformRequest,
  type TransformWebSocketUrl,
} from "@iterate-com/msw-http-server";
import type { RequestHandler, SharedOptions, WebSocketHandler } from "msw";
import type { SetupServerApi } from "msw/node";
import type { Har } from "har-format";
import httpProxy from "http-proxy";
import mockttp from "mockttp";
import { request } from "undici";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { HarJournal } from "../msw-http-proxy/har-journal.ts";
import {
  PROXY_HEADERS_TO_STRIP,
  createProxyRequestTransform,
  createProxyWebSocketUrlTransform,
} from "../proxy-request-transform.ts";
import { createSimpleHarReplayHandler } from "../simple-har-replay-handler.ts";

type AnyHandler = RequestHandler | WebSocketHandler;
type MockHttpServerMode = "record" | "replay" | "replay-or-record";

export type UseMockHttpServerOptions = {
  harPath?: string;
  mode?: MockHttpServerMode;
  handlers?: AnyHandler[];
  onUnhandledRequest?: SharedOptions["onUnhandledRequest"];
  port?: number;
  host?: string;
  /**
   * Rewrite the incoming HTTP request before MSW handler resolution.
   * Defaults to the standard `Forwarded` header rewriter.
   * Pass `false` to disable rewriting entirely.
   */
  transformRequest?: TransformRequest | false;
  /**
   * Rewrite the incoming WebSocket upgrade URL before MSW handler resolution.
   * Defaults to the standard `Forwarded` header rewriter.
   * Pass `false` to disable rewriting entirely.
   */
  transformWebSocketUrl?: TransformWebSocketUrl | false;
  /**
   * Record requests handled by MSW handlers into HAR.
   * Default: true.
   */
  recordHandledRequests?: boolean;
};

export type MockHttpServer = AsyncDisposable &
  Pick<SetupServerApi, "use" | "resetHandlers" | "restoreHandlers" | "listHandlers" | "events"> & {
    url: string;
    port: number;
    getHar(): Har;
    writeHar(path?: string): Promise<void>;
  };

type TemporaryDirectoryFixture = Disposable & {
  path: string;
};

type UseMitmProxyOptions = {
  externalEgressProxyUrl: string;
  port?: number;
};

type MitmProxyFixture = AsyncDisposable & {
  url: string;
  port: number;
  envForNode(): Record<string, string>;
};

function resolveMode(options: UseMockHttpServerOptions): MockHttpServerMode | undefined {
  if (options.mode) return options.mode;
  if (!options.harPath) return undefined;
  return existsSync(options.harPath) ? "replay" : "record";
}

function resolveOnUnhandledRequest(
  explicit: SharedOptions["onUnhandledRequest"] | undefined,
  mode: MockHttpServerMode | undefined,
): SharedOptions["onUnhandledRequest"] {
  if (explicit) return explicit;
  if (mode === "record" || mode === "replay-or-record") return "bypass";
  return "error";
}

function headersToRecord(headers: Headers): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    mapped[name] = value;
  }
  return mapped;
}

function mapNodeHeadersToHeaders(input: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

function removeProxyHeadersFromIncoming(req: http.IncomingMessage): void {
  for (const name of PROXY_HEADERS_TO_STRIP) {
    delete req.headers[name];
  }
}

function toBuffer(data: RawData): Buffer {
  if (typeof data === "string") return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((chunk) => toBuffer(chunk)));
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

function wsMessageData(data: RawData, isBinary: boolean): string {
  const buffer = toBuffer(data);
  return isBinary ? buffer.toString("base64") : buffer.toString("utf8");
}

function webSocketProtocolsFromRequest(req: http.IncomingMessage): string[] {
  const raw = firstHeaderValue(req.headers["sec-websocket-protocol"]);
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function buildUpstreamWebSocketHeaders(req: http.IncomingMessage): Record<string, string> {
  const excluded = new Set([
    "host",
    "connection",
    "upgrade",
    "proxy-connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    ...PROXY_HEADERS_TO_STRIP,
  ]);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (excluded.has(name)) continue;
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

export async function useMockHttpServer(
  options: UseMockHttpServerOptions = {},
): Promise<MockHttpServer> {
  const mode = resolveMode(options);
  const onUnhandledRequest = resolveOnUnhandledRequest(options.onUnhandledRequest, mode);
  const harJournal = options.harPath
    ? await HarJournal.fromSource(options.harPath).catch(() => new HarJournal())
    : new HarJournal();

  const builtinHandlers: RequestHandler[] = [];
  if (mode === "replay" || mode === "replay-or-record") {
    builtinHandlers.push(createSimpleHarReplayHandler({ harJournal }));
  }

  const allHandlers: AnyHandler[] = [...(options.handlers ?? []), ...builtinHandlers];
  const passthroughEnabled = mode === "record" || mode === "replay-or-record";
  const recordHandledRequests = options.recordHandledRequests ?? true;

  const transformRequest =
    options.transformRequest === false
      ? undefined
      : (options.transformRequest ?? createProxyRequestTransform());

  const transformWebSocketUrl =
    options.transformWebSocketUrl === false
      ? undefined
      : (options.transformWebSocketUrl ?? createProxyWebSocketUrlTransform());

  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    secure: false,
    ws: true,
    xfwd: true,
  });
  const wsPassthroughServer = new WebSocketServer({ noServer: true });

  type PendingHttpPassthrough = {
    startedAt: number;
    targetUrl: URL;
    method: string;
    requestHeaders: Record<string, string>;
    requestBody: Uint8Array | null;
    requestBodyChunks: Buffer[];
  };
  const pendingHttpPassthrough = new WeakMap<http.IncomingMessage, PendingHttpPassthrough>();

  proxy.on("proxyRes", (proxyRes, req) => {
    const pending = pendingHttpPassthrough.get(req);
    if (!pending) return;

    const responseChunks: Buffer[] = [];
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;

      if (pending.requestBodyChunks.length > 0) {
        pending.requestBody = Buffer.concat(pending.requestBodyChunks);
      }

      const responseBody = Buffer.concat(responseChunks);
      const responseHeaders = mapNodeHeadersToHeaders(proxyRes.headers);
      const response = new Response(responseBody, {
        status: proxyRes.statusCode ?? 0,
        statusText: proxyRes.statusMessage ?? "",
        headers: responseHeaders,
      });

      harJournal.appendHttpExchange({
        startedAt: pending.startedAt,
        durationMs: Date.now() - pending.startedAt,
        method: pending.method,
        targetUrl: pending.targetUrl,
        requestHeaders: pending.requestHeaders,
        requestBody: pending.requestBody,
        response,
        responseBody,
      });
      pendingHttpPassthrough.delete(req);
    };

    proxyRes.on("data", (chunk) => {
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proxyRes.on("end", finalize);
    proxyRes.on("close", finalize);
  });

  const server: NativeMswServer = createNativeMswServer(
    {
      onUnhandledRequest,
      transformRequest,
      transformWebSocketUrl,
      onMockedResponse: ({ request, response }) => {
        if (!recordHandledRequests) return;

        const startedAt = Date.now();
        const requestHeaders = headersToRecord(request.headers);
        const targetUrl = new URL(request.url);
        harJournal.appendHttpExchange({
          startedAt,
          durationMs: Date.now() - startedAt,
          method: request.method,
          targetUrl,
          requestHeaders,
          requestBody: null,
          response,
          responseBody: null,
        });
      },
      onUnhandledHttpRequest: ({ req, res, request }) => {
        if (!passthroughEnabled || onUnhandledRequest === "error") {
          return false;
        }

        const targetUrl = new URL(request.url);
        const startedAt = Date.now();
        const pending: PendingHttpPassthrough = {
          startedAt,
          targetUrl,
          method: request.method,
          requestHeaders: headersToRecord(request.headers),
          requestBody: null,
          requestBodyChunks: [],
        };
        req.on("data", (chunk) => {
          pending.requestBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        pendingHttpPassthrough.set(req, pending);

        req.url = `${targetUrl.pathname}${targetUrl.search}`;
        req.headers.host = targetUrl.host;
        removeProxyHeadersFromIncoming(req);

        proxy.web(
          req,
          res,
          {
            target: `${targetUrl.protocol}//${targetUrl.host}`,
          },
          () => {
            pendingHttpPassthrough.delete(req);
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            }
            res.end("proxy passthrough failed");
          },
        );

        return true;
      },
      onUnhandledWebSocketUpgrade: ({ req, socket, head, requestUrl }) => {
        if (!passthroughEnabled || onUnhandledRequest === "error") {
          return false;
        }

        const startedAt = Date.now();
        const requestHeaders = headersToRecord(mapNodeHeadersToHeaders(req.headers));
        const webSocketMessages: Array<{
          type: "send" | "receive";
          time: number;
          opcode: number;
          data: string;
        }> = [];

        let responseStatus = 101;
        let responseStatusText = "Switching Protocols";
        let responseHeaders = new Headers();
        let finalized = false;
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          harJournal.appendWebSocketExchange({
            startedAt,
            durationMs: Date.now() - startedAt,
            targetUrl: requestUrl,
            requestHeaders,
            responseStatus,
            responseStatusText,
            responseHeaders,
            messages: webSocketMessages,
          });
        };

        removeProxyHeadersFromIncoming(req);
        wsPassthroughServer.handleUpgrade(req, socket, head, (clientSocket) => {
          const upstreamHeaders = buildUpstreamWebSocketHeaders(req);
          const upstreamProtocols = webSocketProtocolsFromRequest(req);
          const upstreamSocket =
            upstreamProtocols.length > 0
              ? new WebSocket(requestUrl.toString(), upstreamProtocols, {
                  headers: upstreamHeaders,
                })
              : new WebSocket(requestUrl.toString(), { headers: upstreamHeaders });

          const queuedClientMessages: Array<{ data: RawData; isBinary: boolean }> = [];

          upstreamSocket.on("upgrade", (response) => {
            responseStatus = response.statusCode ?? 101;
            responseStatusText = response.statusMessage ?? "Switching Protocols";
            responseHeaders = mapNodeHeadersToHeaders(response.headers);
          });

          clientSocket.on("message", (data, isBinary) => {
            webSocketMessages.push({
              type: "send",
              time: Date.now() / 1000,
              opcode: isBinary ? 2 : 1,
              data: wsMessageData(data, isBinary),
            });

            if (upstreamSocket.readyState === WebSocket.OPEN) {
              upstreamSocket.send(data, { binary: isBinary });
              return;
            }
            queuedClientMessages.push({ data, isBinary });
          });

          upstreamSocket.on("open", () => {
            for (const queued of queuedClientMessages) {
              upstreamSocket.send(queued.data, { binary: queued.isBinary });
            }
            queuedClientMessages.length = 0;
          });

          upstreamSocket.on("message", (data, isBinary) => {
            webSocketMessages.push({
              type: "receive",
              time: Date.now() / 1000,
              opcode: isBinary ? 2 : 1,
              data: wsMessageData(data, isBinary),
            });
            if (clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(data, { binary: isBinary });
            }
          });

          clientSocket.on("close", () => {
            if (
              upstreamSocket.readyState === WebSocket.OPEN ||
              upstreamSocket.readyState === WebSocket.CONNECTING
            ) {
              upstreamSocket.close();
            }
            finalize();
          });

          upstreamSocket.on("close", () => {
            if (
              clientSocket.readyState === WebSocket.OPEN ||
              clientSocket.readyState === WebSocket.CONNECTING
            ) {
              clientSocket.close();
            }
            finalize();
          });

          clientSocket.on("error", () => {
            if (
              upstreamSocket.readyState === WebSocket.OPEN ||
              upstreamSocket.readyState === WebSocket.CONNECTING
            ) {
              upstreamSocket.close();
            }
            finalize();
          });

          upstreamSocket.on("error", () => {
            if (
              clientSocket.readyState === WebSocket.OPEN ||
              clientSocket.readyState === WebSocket.CONNECTING
            ) {
              clientSocket.close();
            }
            finalize();
          });
        });
        return true;
      },
    },
    ...allHandlers,
  );

  const host = options.host ?? "127.0.0.1";
  server.listen(options.port ?? 0, host);
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${String(port)}`;

  return {
    url,
    port,
    use: server.use.bind(server),
    resetHandlers: server.resetHandlers.bind(server),
    restoreHandlers: server.restoreHandlers.bind(server),
    listHandlers: server.listHandlers.bind(server),
    events: server.events,
    getHar() {
      return harJournal.getHar();
    },
    async writeHar(path = options.harPath) {
      if (!path) throw new Error("no harPath configured");
      await harJournal.write(path);
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      proxy.close();
      wsPassthroughServer.close();
      if (options.harPath) {
        await harJournal.write(options.harPath);
      }
    },
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toOriginalUrl(
  rawUrl: string,
  headers: Record<string, string | string[] | undefined>,
): URL {
  if (/^https?:\/\//i.test(rawUrl) || /^wss?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }

  const host = firstHeaderValue(headers.host);
  if (!host) {
    throw new Error("missing host header for proxied request");
  }
  return new URL(rawUrl, `https://${host}`);
}

export function useTemporaryDirectory(prefix = "mock-http-proxy-api-"): TemporaryDirectoryFixture {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    [Symbol.dispose]() {
      rmSync(path, { force: true, recursive: true });
    },
  };
}

export async function useMitmProxy(options: UseMitmProxyOptions): Promise<MitmProxyFixture> {
  const ca = await mockttp.generateCACertificate();
  const tempDirPath = await mkdtemp(join(tmpdir(), "mock-http-proxy-mitm-ca-"));
  const caCertPath = join(tempDirPath, "ca.pem");
  await writeFile(caCertPath, ca.cert, "utf8");

  const mitmServer = mockttp.getLocal({ https: ca });
  const egressUrl = new URL(options.externalEgressProxyUrl);
  const _egressWsUrl = `ws://${egressUrl.host}`;

  await mitmServer.forAnyRequest().thenCallback(async (req) => {
    const originalUrl = toOriginalUrl(req.url, req.headers);
    const bodyBuffer = req.body ? await req.body.getDecodedBuffer() : undefined;

    const response = await request(
      `${options.externalEgressProxyUrl}${originalUrl.pathname}${originalUrl.search}`,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: egressUrl.host,
          forwarded: `host=${originalUrl.host};proto=${originalUrl.protocol.replace(":", "")}`,
        },
        body: bodyBuffer,
      },
    );
    const responseBody = response.body ? Buffer.from(await response.body.arrayBuffer()) : undefined;

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: responseBody,
    };
  });
  await mitmServer.forAnyWebSocket().thenPassThrough({
    transformRequest: {
      setProtocol: "ws",
      replaceHost: {
        targetHost: egressUrl.host,
        updateHostHeader: false,
      },
    },
  });
  await mitmServer.start(options.port ?? 0);

  return {
    url: mitmServer.url,
    port: mitmServer.port,
    envForNode() {
      return {
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: mitmServer.url,
        HTTPS_PROXY: mitmServer.url,
        http_proxy: mitmServer.url,
        https_proxy: mitmServer.url,
        NODE_EXTRA_CA_CERTS: caCertPath,
      };
    },
    async [Symbol.asyncDispose]() {
      await mitmServer.stop();
      await rm(tempDirPath, { force: true, recursive: true });
    },
  };
}
