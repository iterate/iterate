import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import type tls from "node:tls";
import { WebSocketServer, type RawData as WsRawData, type WebSocket as WsSocket } from "ws";
import { handleRequest, RequestHandler, WebSocketHandler } from "msw";
import type * as msw from "msw";
import { setupServer } from "msw/node";
import type * as mswNode from "msw/node";
import { incomingHeadersToHeaders } from "./msw-server-adapter.http-utils.ts";
import {
  bridgeWebSocketToUpstream,
  firstHeaderValue,
  parseWebSocketProtocols,
} from "./msw-server-adapter.websocket-upstream-bridge.ts";

type AnyHandler = msw.RequestHandler | msw.WebSocketHandler;
type UnhandledAction = "bypass" | "error";
type LifecycleEmitter = Pick<EventEmitter, "on" | "emit" | "removeListener" | "removeAllListeners">;

type NativeMswServerApi = Pick<
  mswNode.SetupServerApi,
  "use" | "resetHandlers" | "restoreHandlers" | "listHandlers" | "events"
>;

export type NativeMswServer = http.Server & NativeMswServerApi;

export type TransformRequest = (request: Request) => Request;
export type TransformWebSocketUrl = (url: URL, headers: Headers) => URL;

export type CreateNativeMswServerOptions = {
  onUnhandledRequest?: msw.SharedOptions["onUnhandledRequest"];
  /**
   * Advanced option mirroring MSW's internal `resolutionContext.baseUrl`.
   * Useful for extension/e2e scenarios with pathname-only handlers.
   */
  resolutionContextBaseUrl?: string;
  /**
   * Rewrite the incoming HTTP request before MSW handler resolution.
   * The default identity function passes the request through unchanged.
   * Use this to reconstruct the original target URL from proxy headers.
   */
  transformRequest?: TransformRequest;
  /**
   * Rewrite the incoming WebSocket upgrade URL before MSW handler resolution.
   * The default identity function passes the URL through unchanged.
   * Use this to reconstruct the original target URL from proxy headers.
   */
  transformWebSocketUrl?: TransformWebSocketUrl;
  /**
   * Called when a request is handled by an MSW handler.
   */
  onMockedResponse?: (input: {
    request: Request;
    response: Response;
    requestId: string;
  }) => void | Promise<void>;
  /**
   * Called when an unhandled request is bypassed to the real upstream.
   */
  onPassthroughResponse?: (input: {
    request: Request;
    response: Response;
    requestId: string;
  }) => void | Promise<void>;
  /**
   * Called when MSW returns no response for an HTTP request.
   * Return true when the callback handled the request and wrote to `res`.
   */
  onUnhandledHttpRequest?: (input: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    request: Request;
    requestId: string;
  }) => boolean | Promise<boolean>;
  /**
   * Called when no MSW websocket handler matched an upgrade request.
   * Return true when handled.
   */
  onUnhandledWebSocketUpgrade?: (input: {
    req: http.IncomingMessage;
    socket: tls.TLSSocket;
    head: Buffer;
    requestUrl: URL;
  }) => boolean;
};

function isRequestHandler(handler: AnyHandler): handler is msw.RequestHandler {
  return handler instanceof RequestHandler;
}

function isWebSocketHandler(handler: AnyHandler): handler is msw.WebSocketHandler {
  return handler instanceof WebSocketHandler;
}

function incomingToWebSocketUrl(req: http.IncomingMessage): URL {
  const protocol =
    "encrypted" in req.socket && Boolean((req.socket as tls.TLSSocket).encrypted) ? "wss:" : "ws:";
  const host = req.headers.host ?? "localhost";
  return new URL(req.url ?? "/", `${protocol}//${host}`);
}

function normalizeWebSocketBaseUrl(baseUrl: string | undefined, requestUrl: URL): string {
  const parsed = new URL(baseUrl ?? requestUrl.origin);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return new URL("/", parsed).toString();
}

function normalizeSocketHost(value: string): string {
  return value.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeSocketHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function resolvedPort(url: URL): number {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:" || url.protocol === "wss:") return 443;
  return 80;
}

function isSelfTargetUrl(targetUrl: URL, req: http.IncomingMessage): boolean {
  const localPort = req.socket.localPort;
  if (!localPort) return false;
  if (resolvedPort(targetUrl) !== localPort) return false;

  const targetHost = normalizeSocketHost(targetUrl.hostname);
  const localAddress = normalizeSocketHost(req.socket.localAddress ?? "");
  if (isLoopbackHost(targetHost)) return true;
  if (localAddress && targetHost === localAddress) return true;
  return false;
}

function writeHttpError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function writeUpgradeError(socket: tls.TLSSocket, status: number, message: string): void {
  const statusText = status === 502 ? "Bad Gateway" : "Internal Server Error";
  socket.write(
    [
      `HTTP/1.1 ${String(status)} ${statusText}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${String(Buffer.byteLength(message, "utf8"))}`,
      "",
      message,
    ].join("\r\n"),
  );
  socket.destroy();
}

function resolveUnhandledAction(
  strategy: msw.SharedOptions["onUnhandledRequest"],
  request: Request,
): UnhandledAction {
  const effectiveStrategy = strategy ?? "warn";
  if (typeof effectiveStrategy === "function") {
    let action: UnhandledAction = "bypass";
    try {
      effectiveStrategy(request, {
        warning() {
          action = "bypass";
        },
        error() {
          action = "error";
        },
      });
    } catch {
      return "error";
    }
    return action;
  }
  return effectiveStrategy === "error" ? "error" : "bypass";
}

function wsRawDataToPayload(data: WsRawData, isBinary: boolean): unknown {
  if (!isBinary) {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    return Buffer.from(data).toString("utf8");
  }

  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function createCloseEvent(code: number, reason: string, wasClean: boolean): Event {
  const event = new Event("close");
  Object.defineProperty(event, "code", { value: code, enumerable: true });
  Object.defineProperty(event, "reason", { value: reason, enumerable: true });
  Object.defineProperty(event, "wasClean", { value: wasClean, enumerable: true });
  return event;
}

function createMessageEvent(data: unknown): Event {
  const event = new Event("message", { cancelable: true });
  Object.defineProperty(event, "data", { value: data, enumerable: true });
  Object.defineProperty(event, "origin", { value: "", enumerable: true });
  return event;
}

function wsDataToSendPayload(data: unknown): string | Buffer | ArrayBuffer | ArrayBufferView {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data;
  if (data instanceof Blob) {
    throw new Error("Blob websocket payloads are not supported by native adapter");
  }
  return String(data);
}

class NativeWebSocketClientConnection {
  public readonly id = randomUUID();
  public readonly url: URL;
  private readonly emitter = new EventTarget();

  constructor(
    private readonly socket: WsSocket,
    url: URL,
  ) {
    this.url = url;

    this.socket.on("message", (data, isBinary) => {
      this.emitter.dispatchEvent(createMessageEvent(wsRawDataToPayload(data, isBinary)));
    });
    this.socket.on("close", (code, reason) => {
      this.emitter.dispatchEvent(createCloseEvent(code, reason.toString("utf8"), true));
    });
  }

  send(data: unknown): void {
    try {
      this.socket.send(wsDataToSendPayload(data));
    } catch {
      return;
    }
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.emitter.addEventListener(type, listener, options);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void {
    this.emitter.removeEventListener(type, listener, options);
  }
}

class NativeWebSocketServerConnection {
  private readonly emitter = new EventTarget();
  private connected = false;

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.emitter.dispatchEvent(new Event("open"));
  }

  send(_data: unknown): void {
    if (!this.connected) {
      throw new Error(
        'Failed to call "server.send()": no upstream websocket exists in native incoming-server mode',
      );
    }
  }

  close(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emitter.dispatchEvent(createCloseEvent(1000, "", true));
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.emitter.addEventListener(type, listener, options);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void {
    this.emitter.removeEventListener(type, listener, options);
  }
}

function incomingToWebRequest(req: http.IncomingMessage): Request {
  const protocol =
    "encrypted" in req.socket && Boolean((req.socket as tls.TLSSocket).encrypted)
      ? "https:"
      : "http:";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}//${host}`);
  const headers = incomingHeadersToHeaders(req.headers);

  const method = req.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : (req as unknown as BodyInit),
    duplex: "half",
  } as RequestInit);
}

async function sendWebResponse(
  res: http.ServerResponse,
  mswRes: Response,
  options: { stripContentHeaders?: boolean } = {},
): Promise<void> {
  res.statusCode = mswRes.status;
  res.statusMessage = mswRes.statusText;

  const blockedHeaderNames = new Set<string>(
    options.stripContentHeaders ? ["content-length", "content-encoding", "transfer-encoding"] : [],
  );
  const groupedHeaders = new Map<string, string[]>();
  for (const [name, value] of mswRes.headers.entries()) {
    if (blockedHeaderNames.has(name.toLowerCase())) continue;
    const existing = groupedHeaders.get(name);
    if (existing) {
      existing.push(value);
      continue;
    }
    groupedHeaders.set(name, [value]);
  }
  for (const [name, values] of groupedHeaders.entries()) {
    res.setHeader(name, values.length === 1 ? values[0]! : values);
  }

  if (mswRes.body) {
    const reader = mswRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }

  res.end();
}

async function passthroughHttpRequest(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("accept-encoding", "identity");

  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
    (init as { duplex?: "half" }).duplex = "half";
  }

  return await fetch(request.url, init);
}

export function createNativeMswServer(
  ...initialHandlers: Array<msw.RequestHandler | msw.WebSocketHandler>
): NativeMswServer;
export function createNativeMswServer(): NativeMswServer;
export function createNativeMswServer(
  options: CreateNativeMswServerOptions,
  ...initialHandlers: Array<msw.RequestHandler | msw.WebSocketHandler>
): NativeMswServer;
export function createNativeMswServer(
  optionsOrHandler?: CreateNativeMswServerOptions | msw.RequestHandler | msw.WebSocketHandler,
  ...restHandlers: Array<msw.RequestHandler | msw.WebSocketHandler>
): NativeMswServer {
  if (optionsOrHandler === undefined) {
    return createNativeMswServer({});
  }

  const hasOptions =
    typeof optionsOrHandler === "object" &&
    optionsOrHandler !== null &&
    !(optionsOrHandler instanceof RequestHandler) &&
    !(optionsOrHandler instanceof WebSocketHandler);
  const options = (hasOptions ? optionsOrHandler : {}) as CreateNativeMswServerOptions;
  const handlers = (
    hasOptions
      ? restHandlers
      : [optionsOrHandler as msw.RequestHandler | msw.WebSocketHandler, ...restHandlers]
  ) as AnyHandler[];

  const msw = setupServer(...handlers);
  const lifecycleEmitter: LifecycleEmitter = new EventEmitter();
  const onUnhandledRequest = options.onUnhandledRequest ?? "warn";
  const resolutionContextBaseUrl = options.resolutionContextBaseUrl;
  const transformRequest = options.transformRequest;
  const transformWebSocketUrl = options.transformWebSocketUrl;
  const onMockedResponse = options.onMockedResponse;
  const onPassthroughResponse = options.onPassthroughResponse;
  const onUnhandledHttpRequest = options.onUnhandledHttpRequest;
  const onUnhandledWebSocketUpgrade = options.onUnhandledWebSocketUpgrade;
  const webSocketServer = new WebSocketServer({ noServer: true });
  const passthroughWebSocketServer = new WebSocketServer({ noServer: true });

  const nodeServer = http.createServer(async (req, res) => {
    try {
      const rawRequest = incomingToWebRequest(req);
      const webRequest = transformRequest ? transformRequest(rawRequest) : rawRequest;
      const activeHandlers = msw.listHandlers().filter(isRequestHandler);
      const requestId = `native-${randomUUID()}`;
      const mockedResponse = await handleRequest(
        webRequest,
        requestId,
        activeHandlers,
        { onUnhandledRequest },
        lifecycleEmitter as never,
        {
          resolutionContext: {
            baseUrl: resolutionContextBaseUrl ?? new URL(webRequest.url).origin,
          },
        },
      );

      if (mockedResponse) {
        lifecycleEmitter.emit("response:mocked", {
          response: mockedResponse,
          request: webRequest,
          requestId,
        });
        await onMockedResponse?.({ request: webRequest, response: mockedResponse, requestId });
        await sendWebResponse(res, mockedResponse);
        return;
      }

      const handled = onUnhandledHttpRequest
        ? await onUnhandledHttpRequest({ req, res, request: webRequest, requestId })
        : false;
      if (handled) {
        return;
      }

      if (isSelfTargetUrl(new URL(webRequest.url), req)) {
        writeHttpError(
          res,
          502,
          "Refusing to bypass request: resolved upstream target points to this same server",
        );
        return;
      }

      try {
        const response = await passthroughHttpRequest(webRequest);
        lifecycleEmitter.emit("response:bypass", {
          response,
          request: webRequest,
          requestId,
        });
        await onPassthroughResponse?.({ request: webRequest, response, requestId });
        await sendWebResponse(res, response, { stripContentHeaders: true });
      } catch (passthroughError) {
        const message =
          passthroughError instanceof Error ? passthroughError.message : String(passthroughError);
        writeHttpError(res, 502, `Unhandled request bypass failed: ${message}`);
      }
    } catch (error) {
      writeHttpError(res, 500, error instanceof Error ? error.message : String(error));
    }
  });

  const bridgeUnhandledWebSocket = (
    req: http.IncomingMessage,
    socket: tls.TLSSocket,
    head: Buffer,
    targetUrl: URL,
  ): void => {
    if (isSelfTargetUrl(targetUrl, req)) {
      writeUpgradeError(
        socket,
        502,
        "Refusing to bypass websocket upgrade: resolved upstream target points to this same server",
      );
      return;
    }

    bridgeWebSocketToUpstream({
      req,
      socket,
      head,
      targetUrl,
      upgradeServer: passthroughWebSocketServer,
      closeClientOnUpstreamError: {
        code: 1011,
        reason: "Unhandled websocket bypass failed",
      },
    });
  };

  const handleUnhandledWebSocketUpgrade = (
    req: http.IncomingMessage,
    socket: tls.TLSSocket,
    head: Buffer,
    requestUrl: URL,
  ): void => {
    if (onUnhandledWebSocketUpgrade) {
      const handled = onUnhandledWebSocketUpgrade({ req, socket, head, requestUrl });
      if (handled) return;
    }

    const action = resolveUnhandledAction(
      onUnhandledRequest,
      new Request(requestUrl, {
        headers: {
          connection: "upgrade",
          upgrade: "websocket",
        },
      }),
    );
    if (action === "error") {
      writeUpgradeError(socket, 500, "Unhandled websocket request denied by onUnhandledRequest");
      return;
    }

    if (isSelfTargetUrl(requestUrl, req) && nodeServer.listenerCount("upgrade") > 1) {
      return;
    }

    bridgeUnhandledWebSocket(req, socket, head, requestUrl);
  };

  nodeServer.on("upgrade", (req, socket, head) => {
    const webSocketHandlers = msw.listHandlers().filter(isWebSocketHandler);
    const rawWsUrl = incomingToWebSocketUrl(req);
    const wsHeaders = incomingHeadersToHeaders(req.headers);
    const requestUrl = transformWebSocketUrl
      ? transformWebSocketUrl(rawWsUrl, wsHeaders)
      : rawWsUrl;
    if (webSocketHandlers.length === 0) {
      handleUnhandledWebSocketUpgrade(req, socket as tls.TLSSocket, head, requestUrl);
      return;
    }

    const resolutionContext = {
      baseUrl: normalizeWebSocketBaseUrl(resolutionContextBaseUrl, requestUrl),
    };

    const matchingHandlers = webSocketHandlers.filter((handler) => {
      const parsedResult = handler.parse({ url: requestUrl, resolutionContext });
      return handler.predicate({ url: requestUrl, parsedResult });
    });

    if (matchingHandlers.length === 0) {
      handleUnhandledWebSocketUpgrade(req, socket as tls.TLSSocket, head, requestUrl);
      return;
    }

    webSocketServer.handleUpgrade(req, socket, head, (clientSocket) => {
      const client = new NativeWebSocketClientConnection(clientSocket, requestUrl);
      const server = new NativeWebSocketServerConnection();
      const protocols = parseWebSocketProtocols(
        firstHeaderValue(req.headers["sec-websocket-protocol"]),
      );

      void Promise.all(
        matchingHandlers.map((handler) =>
          handler.run(
            {
              client: client as never,
              server: server as never,
              info: { protocols },
            },
            resolutionContext,
          ),
        ),
      ).catch(() => {
        clientSocket.close(1011, "MSW websocket handler error");
      });
    });
  });

  const nodeClose = nodeServer.close.bind(nodeServer);
  const lifecycleEvents = {
    on: lifecycleEmitter.on.bind(lifecycleEmitter),
    removeListener: lifecycleEmitter.removeListener.bind(lifecycleEmitter),
    removeAllListeners: lifecycleEmitter.removeAllListeners.bind(lifecycleEmitter),
  };

  return Object.assign(nodeServer, {
    use: msw.use.bind(msw),
    resetHandlers: msw.resetHandlers.bind(msw),
    restoreHandlers: msw.restoreHandlers.bind(msw),
    listHandlers: msw.listHandlers.bind(msw),
    events: lifecycleEvents,
    close(callback?: (error?: Error) => void) {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      for (const client of passthroughWebSocketServer.clients) {
        client.terminate();
      }
      webSocketServer.close();
      passthroughWebSocketServer.close();
      msw.close();
      return nodeClose(callback);
    },
  }) as NativeMswServer;
}
