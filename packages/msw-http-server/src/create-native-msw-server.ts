import { randomUUID } from "node:crypto";
import http from "node:http";
import type tls from "node:tls";
import { WebSocketServer, type RawData as WsRawData, type WebSocket as WsSocket } from "ws";
import {
  handleRequest,
  type LifeCycleEventsMap,
  type RequestHandler,
  type SharedOptions,
  type WebSocketHandler,
} from "msw";
import { setupServer, type SetupServerApi } from "msw/node";

type AnyHandler = RequestHandler | WebSocketHandler;
type NativeMswLifecycleEventName = `${string}:${string}`;

type NativeMswServerApi = Pick<
  SetupServerApi,
  "use" | "resetHandlers" | "restoreHandlers" | "listHandlers" | "events" | "boundary"
>;

export type NativeMswServer = http.Server & NativeMswServerApi;

export type CreateNativeMswServerOptions = {
  onUnhandledRequest?: SharedOptions["onUnhandledRequest"];
  /**
   * Advanced option mirroring MSW's internal `resolutionContext.baseUrl`.
   * Useful for extension/e2e scenarios with pathname-only handlers.
   */
  resolutionContextBaseUrl?: string;
};

function isRequestHandler(handler: AnyHandler): handler is RequestHandler {
  return (handler as unknown as { __kind?: string }).__kind === "RequestHandler";
}

function isWebSocketHandler(handler: AnyHandler): handler is WebSocketHandler {
  return (handler as unknown as { __kind?: string }).__kind === "EventHandler";
}

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
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

function parseWebSocketProtocols(headerValue: string): string | Array<string> | undefined {
  if (!headerValue) return undefined;
  const protocols = headerValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (protocols.length === 0) return undefined;
  if (protocols.length === 1) return protocols[0];
  return protocols;
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

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }

  const method = req.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : (req as unknown as BodyInit),
    duplex: "half",
  } as RequestInit);
}

async function sendWebResponse(res: http.ServerResponse, mswRes: Response): Promise<void> {
  res.statusCode = mswRes.status;
  res.statusMessage = mswRes.statusText;

  mswRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

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

function isLifecycleEventName(event: string | symbol): event is NativeMswLifecycleEventName {
  return typeof event === "string" && event.includes(":");
}

export function createNativeMswServer(
  ...initialHandlers: Array<RequestHandler | WebSocketHandler>
): NativeMswServer;
export function createNativeMswServer(): NativeMswServer;
export function createNativeMswServer(
  options: CreateNativeMswServerOptions,
  ...initialHandlers: Array<RequestHandler | WebSocketHandler>
): NativeMswServer;
export function createNativeMswServer(
  optionsOrHandler?: CreateNativeMswServerOptions | RequestHandler | WebSocketHandler,
  ...restHandlers: Array<RequestHandler | WebSocketHandler>
): NativeMswServer {
  if (optionsOrHandler === undefined) {
    return createNativeMswServer({});
  }

  const hasOptions =
    typeof optionsOrHandler === "object" &&
    optionsOrHandler !== null &&
    !("__kind" in (optionsOrHandler as object));
  const options = (hasOptions ? optionsOrHandler : {}) as CreateNativeMswServerOptions;
  const handlers = (
    hasOptions
      ? restHandlers
      : [optionsOrHandler as RequestHandler | WebSocketHandler, ...restHandlers]
  ) as AnyHandler[];

  const msw = setupServer(...handlers);
  const internalEmitter = (
    msw as unknown as {
      emitter: {
        emit: (event: keyof LifeCycleEventsMap, ...args: Array<any>) => void;
        on: (event: keyof LifeCycleEventsMap, listener: (...args: Array<any>) => void) => void;
        removeListener: (
          event: keyof LifeCycleEventsMap,
          listener: (...args: Array<any>) => void,
        ) => void;
        removeAllListeners: (event?: keyof LifeCycleEventsMap) => void;
      };
    }
  ).emitter;
  const onUnhandledRequest = options.onUnhandledRequest ?? "warn";
  const resolutionContextBaseUrl = options.resolutionContextBaseUrl;
  const webSocketServer = new WebSocketServer({ noServer: true });

  const nodeServer = http.createServer(async (req, res) => {
    try {
      const webRequest = incomingToWebRequest(req);
      const activeHandlers = msw.listHandlers().filter(isRequestHandler);
      const requestId = `native-${randomUUID()}`;
      const mockedResponse = await handleRequest(
        webRequest,
        requestId,
        activeHandlers,
        { onUnhandledRequest },
        internalEmitter as never,
        {
          resolutionContext: {
            baseUrl: resolutionContextBaseUrl ?? new URL(webRequest.url).origin,
          },
        },
      );

      if (mockedResponse) {
        internalEmitter.emit("response:mocked", {
          response: mockedResponse,
          request: webRequest,
          requestId,
        });
        await sendWebResponse(res, mockedResponse);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("No MSW handler matched");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  nodeServer.on("upgrade", (req, socket, head) => {
    const webSocketHandlers = msw.listHandlers().filter(isWebSocketHandler);
    if (webSocketHandlers.length === 0) return;

    const requestUrl = incomingToWebSocketUrl(req);
    const resolutionContext = {
      baseUrl: normalizeWebSocketBaseUrl(resolutionContextBaseUrl, requestUrl),
    };

    const matchingHandlers = webSocketHandlers.filter((handler) => {
      const parsedResult = handler.parse({ url: requestUrl, resolutionContext });
      return handler.predicate({ url: requestUrl, parsedResult });
    });

    if (matchingHandlers.length === 0) {
      return;
    }

    webSocketServer.handleUpgrade(req, socket, head, (clientSocket) => {
      const client = new NativeWebSocketClientConnection(clientSocket, requestUrl);
      const server = new NativeWebSocketServerConnection();
      const protocols = parseWebSocketProtocols(firstHeader(req.headers["sec-websocket-protocol"]));

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

  const nodeOn = nodeServer.on.bind(nodeServer);
  const nodeOnce = nodeServer.once.bind(nodeServer);
  const nodeOff = nodeServer.off.bind(nodeServer);
  const nodeRemoveAllListeners = nodeServer.removeAllListeners.bind(nodeServer);
  const nodeClose = nodeServer.close.bind(nodeServer);

  return Object.assign(nodeServer, {
    use: msw.use.bind(msw),
    resetHandlers: msw.resetHandlers.bind(msw),
    restoreHandlers: msw.restoreHandlers.bind(msw),
    listHandlers: msw.listHandlers.bind(msw),
    boundary: msw.boundary.bind(msw),
    events: msw.events,
    on(event: string | symbol, listener: (...args: Array<any>) => void) {
      nodeOn(event, listener);
      if (isLifecycleEventName(event)) {
        msw.events.on(event as never, listener as never);
      }
      return this;
    },
    once(event: string | symbol, listener: (...args: Array<any>) => void) {
      nodeOnce(event, listener);
      if (isLifecycleEventName(event)) {
        const onceListener = (...args: Array<any>) => {
          msw.events.removeListener(event as never, onceListener as never);
          listener(...args);
        };
        msw.events.on(event as never, onceListener as never);
      }
      return this;
    },
    off(event: string | symbol, listener: (...args: Array<any>) => void) {
      nodeOff(event, listener);
      if (isLifecycleEventName(event)) {
        msw.events.removeListener(event as never, listener as never);
      }
      return this;
    },
    removeAllListeners(event?: string | symbol) {
      nodeRemoveAllListeners(event);
      if (event && isLifecycleEventName(event)) {
        msw.events.removeAllListeners(event as never);
      } else if (!event) {
        msw.events.removeAllListeners();
      }
      return this;
    },
    close(callback?: (error?: Error) => void) {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      webSocketServer.close();
      msw.close();
      return nodeClose(callback);
    },
  }) as NativeMswServer;
}
