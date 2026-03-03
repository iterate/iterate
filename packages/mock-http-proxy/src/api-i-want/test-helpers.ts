import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  bridgeWebSocketToUpstream,
  createNativeMswServer,
  incomingHeadersToHeaders,
  type NativeMswServer,
  type TransformRequest,
  type TransformWebSocketUrl,
} from "@iterate-com/msw-http-server";
import { buildForwardedHeader } from "@iterate-com/shared/forwarded-header";
import type { SharedOptions } from "msw";
import type { SetupServerApi } from "msw/node";
import type { Har } from "har-format";
import mockttp from "mockttp";
import { request } from "undici";
import { WebSocketServer, type RawData } from "ws";
import { HarRecorder, type RecorderOpts } from "./recorder.ts";
import {
  PROXY_HEADERS_TO_STRIP,
  createProxyRequestTransform,
  createProxyWebSocketUrlTransform,
} from "../proxy-request-transform.ts";

export type UseMockHttpServerOptions = {
  /**
   * @deprecated Use recorder.harPath instead.
   */
  harPath?: string;
  recorder?: RecorderOpts;
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
   * @deprecated Use recorder.includeHandledRequests instead.
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

function resolveOnUnhandledRequest(
  explicit: SharedOptions["onUnhandledRequest"] | undefined,
): SharedOptions["onUnhandledRequest"] {
  if (explicit) return explicit;
  return "error";
}

function headersToRecord(headers: Headers): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    mapped[name] = value;
  }
  return mapped;
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

export async function useMockHttpServer(
  options: UseMockHttpServerOptions = {},
): Promise<MockHttpServer> {
  const onUnhandledRequest = resolveOnUnhandledRequest(options.onUnhandledRequest);
  const recorderOptions: RecorderOpts = {
    ...(options.recorder ?? {}),
    ...(options.harPath !== undefined && options.recorder?.harPath === undefined
      ? { harPath: options.harPath }
      : {}),
    ...(options.recordHandledRequests !== undefined &&
    options.recorder?.includeHandledRequests === undefined
      ? { includeHandledRequests: options.recordHandledRequests }
      : {}),
  };
  const recorder = await HarRecorder.create(recorderOptions);

  const transformRequest =
    options.transformRequest === false
      ? undefined
      : (options.transformRequest ?? createProxyRequestTransform());

  const transformWebSocketUrl =
    options.transformWebSocketUrl === false
      ? undefined
      : (options.transformWebSocketUrl ?? createProxyWebSocketUrlTransform());

  const wsPassthroughServer = new WebSocketServer({ noServer: true });

  const server: NativeMswServer = createNativeMswServer({
    onUnhandledRequest,
    transformRequest,
    transformWebSocketUrl,
    onMockedResponse: async ({ request, response }) => {
      const startedAt = Date.now();
      const requestHeaders = headersToRecord(request.headers);
      const targetUrl = new URL(request.url);
      let requestBody: Uint8Array | null = null;
      if (request.method !== "GET" && request.method !== "HEAD" && !request.bodyUsed) {
        try {
          requestBody = Buffer.from(await request.clone().arrayBuffer());
        } catch {
          requestBody = null;
        }
      }
      const responseBody = response.body ? Buffer.from(await response.clone().arrayBuffer()) : null;

      recorder.appendHttpExchange(
        {
          startedAt,
          durationMs: Date.now() - startedAt,
          method: request.method,
          targetUrl,
          requestHeaders,
          requestBody,
          response,
          responseBody,
        },
        "handled",
      );
    },
    onPassthroughResponse: async ({ request, response }) => {
      const startedAt = Date.now();
      const targetUrl = new URL(request.url);
      const requestHeaders = headersToRecord(request.headers);
      const requestBody = null;
      const responseBody = response.body ? Buffer.from(await response.clone().arrayBuffer()) : null;

      recorder.appendHttpExchange(
        {
          startedAt,
          durationMs: Date.now() - startedAt,
          method: request.method,
          targetUrl,
          requestHeaders,
          requestBody,
          response,
          responseBody,
        },
        "passthrough",
      );
    },
    onUnhandledWebSocketUpgrade: ({ req, socket, head, requestUrl }) => {
      if (onUnhandledRequest === "error") {
        return false;
      }

      const startedAt = Date.now();
      const requestHeaders = headersToRecord(incomingHeadersToHeaders(req.headers));
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
        recorder.appendWebSocketExchange({
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

      bridgeWebSocketToUpstream({
        req,
        socket,
        head,
        targetUrl: requestUrl,
        upgradeServer: wsPassthroughServer,
        excludeRequestHeaderNames: PROXY_HEADERS_TO_STRIP,
        onUpstreamUpgrade: (response) => {
          responseStatus = response.statusCode ?? 101;
          responseStatusText = response.statusMessage ?? "Switching Protocols";
          responseHeaders = incomingHeadersToHeaders(response.headers);
        },
        onClientMessage: (data, isBinary) => {
          webSocketMessages.push({
            type: "send",
            time: Date.now() / 1000,
            opcode: isBinary ? 2 : 1,
            data: wsMessageData(data as RawData, isBinary),
          });
        },
        onUpstreamMessage: (data, isBinary) => {
          webSocketMessages.push({
            type: "receive",
            time: Date.now() / 1000,
            opcode: isBinary ? 2 : 1,
            data: wsMessageData(data as RawData, isBinary),
          });
        },
        onFinalize: finalize,
      });
      return true;
    },
  });

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
      return recorder.getHar();
    },
    async writeHar(path = recorder.configuredHarPath()) {
      await recorder.write(path);
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wsPassthroughServer.close();
      await recorder.writeConfiguredIfAny();
    },
  };
}

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
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
    const forwarded = buildForwardedHeader({
      for: req.remoteIpAddress,
      host: originalUrl.host,
      proto: originalUrl.protocol,
    });

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers.set(name, value);
        continue;
      }
      if (Array.isArray(value)) {
        headers.set(name, value.join(", "));
      }
    }
    headers.set("host", egressUrl.host);
    if (forwarded) {
      headers.set("forwarded", forwarded);
    }

    const response = await request(
      `${options.externalEgressProxyUrl}${originalUrl.pathname}${originalUrl.search}`,
      {
        method: req.method,
        headers,
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
