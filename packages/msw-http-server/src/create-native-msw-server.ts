import { randomUUID } from "node:crypto";
import http from "node:http";
import type tls from "node:tls";
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
      msw.close();
      return nodeClose(callback);
    },
  }) as NativeMswServer;
}
