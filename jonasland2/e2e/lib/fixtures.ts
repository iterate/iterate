import { DockerClient } from "@docker/node-sdk";
import { createMiddleware } from "@mswjs/http-middleware";
import express from "express";
import type { RequestHandler as MswRequestHandler } from "msw";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";

type MswHandler = MswRequestHandler;
type MswOnUnhandledRequest = "bypass" | "warn" | "error";
type MswRequestPhase = "start" | "match" | "unhandled" | "end";

export interface MswRequestRecord {
  phase: MswRequestPhase;
  requestId: string;
  method: string;
  url: URL;
  request: Request;
  atMs: number;
}

export interface MswRequestFilter {
  method?: string;
  url?: string | RegExp | ((url: URL) => boolean);
  pathname?: string | RegExp;
  predicate?: (record: MswRequestRecord) => boolean;
}

export interface WaitForRequestOptions {
  phase?: MswRequestPhase;
  timeoutMs?: number;
}

let dockerClientPromise: Promise<DockerClient> | undefined;
async function dockerClient(): Promise<DockerClient> {
  dockerClientPromise ??= DockerClient.fromDockerConfig();
  return await dockerClientPromise;
}

function toEnvArray(env?: Record<string, string> | string[]): string[] | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function exposedPortsMap(exposedPorts?: string[]): Record<string, {}> | undefined {
  if (!exposedPorts || exposedPorts.length === 0) return undefined;
  return Object.fromEntries(exposedPorts.map((port) => [port, {}]));
}

function portBindingsMap(
  exposedPorts?: string[],
): Record<string, Array<{ HostPort: string }>> | undefined {
  if (!exposedPorts || exposedPorts.length === 0) return undefined;
  return Object.fromEntries(exposedPorts.map((port) => [port, [{ HostPort: "" }]]));
}

function captureOutput(stream: PassThrough): { flush: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return {
    flush() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

function sanitizeHeaders(headers: Headers | Record<string, string | string[] | undefined>) {
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
  ]);

  const next: Record<string, string> = {};

  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      if (!hopByHop.has(key.toLowerCase())) next[key] = value;
    }
    return next;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (hopByHop.has(key.toLowerCase())) continue;
    next[key] = Array.isArray(value) ? value.join(",") : value;
  }

  return next;
}

function urlMatches(
  actual: URL,
  expected: string | RegExp | ((url: URL) => boolean) | undefined,
): boolean {
  if (!expected) return true;
  if (typeof expected === "string") return actual.toString() === expected;
  if (expected instanceof RegExp) return expected.test(actual.toString());
  return expected(actual);
}

function pathnameMatches(actual: URL, expected: string | RegExp | undefined): boolean {
  if (!expected) return true;
  if (typeof expected === "string") return actual.pathname === expected;
  return expected.test(actual.pathname);
}

function requestMatches(record: MswRequestRecord, filter: MswRequestFilter): boolean {
  if (filter.method && record.method.toUpperCase() !== filter.method.toUpperCase()) return false;
  if (!urlMatches(record.url, filter.url)) return false;
  if (!pathnameMatches(record.url, filter.pathname)) return false;
  if (filter.predicate && !filter.predicate(record)) return false;
  return true;
}

function recordFromEvent(
  phase: MswRequestPhase,
  requestId: string,
  request: Request,
): MswRequestRecord {
  return {
    phase,
    requestId,
    method: request.method,
    url: new URL(request.url),
    request,
    atMs: Date.now(),
  };
}

function summarizeRequestRecords(records: MswRequestRecord[]): string {
  return records
    .map((record) => `${record.phase.toUpperCase()} ${record.method} ${record.url.toString()}`)
    .join("\n");
}

export async function dockerPing(): Promise<boolean> {
  try {
    const docker = await dockerClient();
    await docker.systemPing();
    return true;
  } catch {
    return false;
  }
}

export interface DockerContainerFixture extends AsyncDisposable {
  containerId: string;
  publishedPort(containerPort: string): Promise<number>;
  logs(): Promise<string>;
}

export async function dockerContainerFixture(params: {
  image: string;
  name?: string;
  env?: Record<string, string> | string[];
  exposedPorts?: string[];
  extraHosts?: string[];
  capAdd?: string[];
}): Promise<DockerContainerFixture> {
  const docker = await dockerClient();
  const created = await docker.containerCreate(
    {
      Image: params.image,
      Env: toEnvArray(params.env),
      ExposedPorts: exposedPortsMap(params.exposedPorts),
      HostConfig: {
        PortBindings: portBindingsMap(params.exposedPorts),
        ExtraHosts: params.extraHosts,
        CapAdd: params.capAdd,
      },
    },
    { name: params.name },
  );

  if (!created.Id) throw new Error("docker container create id missing");

  await docker.containerStart(created.Id);

  return {
    containerId: created.Id,
    async publishedPort(containerPort: string) {
      const inspect = await docker.containerInspect(created.Id);
      const mapping = inspect.NetworkSettings?.Ports?.[containerPort];
      const hostPort = mapping?.[0]?.HostPort;
      if (!hostPort) {
        throw new Error(`No published port for ${containerPort} on container ${created.Id}`);
      }
      return Number(hostPort);
    },
    async logs() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutCapture = captureOutput(stdout);
      const stderrCapture = captureOutput(stderr);

      await docker.containerLogs(created.Id, stdout, stderr, {
        stdout: true,
        stderr: true,
        tail: "all",
      });

      return `${stdoutCapture.flush()}${stderrCapture.flush()}`;
    },
    async [Symbol.asyncDispose]() {
      await docker.containerStop(created.Id, { timeout: 3 }).catch(() => {});
      await docker.containerDelete(created.Id, { force: true }).catch(() => {});
    },
  };
}

export async function execInContainer(params: {
  containerId: string;
  cmd: string[];
}): Promise<{ exitCode: number; output: string }> {
  const docker = await dockerClient();
  const exec = await docker.containerExec(params.containerId, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: params.cmd,
  });

  if (!exec.Id) throw new Error("docker exec id missing");

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutCapture = captureOutput(stdout);
  const stderrCapture = captureOutput(stderr);

  await docker.execStart(exec.Id, stdout, stderr, { Detach: false, Tty: false });
  const inspect = await docker.execInspect(exec.Id);

  return {
    exitCode: inspect.ExitCode ?? 0,
    output: `${stdoutCapture.flush()}${stderrCapture.flush()}`,
  };
}

export interface MswProxyFixture extends AsyncDisposable {
  proxyUrl: string;
  hostProxyUrl: string;
  use(...handlers: MswHandler[]): void;
  resetHandlers(...handlers: MswHandler[]): void;
  restoreHandlers(): void;
  boundary<Args extends Array<unknown>, ReturnValue>(
    callback: (...args: Args) => ReturnValue,
  ): (...args: Args) => ReturnValue;
  listRequests(phase?: MswRequestPhase): MswRequestRecord[];
  waitForRequest(
    filter: MswRequestFilter,
    options?: WaitForRequestOptions,
  ): Promise<MswRequestRecord>;
  expectRequest(
    filter: MswRequestFilter,
    options?: WaitForRequestOptions,
  ): Promise<MswRequestRecord>;
  expectNoUnhandledRequests(filter?: MswRequestFilter): void;
}

export interface WebSocketHandshakeRecord {
  pathname: string;
  headers: IncomingHttpHeaders;
}

export interface WebSocketEchoServerFixture extends AsyncDisposable {
  url: string;
  waitForHandshake(options?: {
    pathname?: string;
    timeoutMs?: number;
    predicate?: (record: WebSocketHandshakeRecord) => boolean;
  }): Promise<WebSocketHandshakeRecord>;
}

export async function webSocketEchoServerFixture(): Promise<WebSocketEchoServerFixture> {
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  const handshakes: WebSocketHandshakeRecord[] = [];
  const pendingWaiters: Array<{
    resolve: (record: WebSocketHandshakeRecord) => void;
    reject: (error: Error) => void;
    pathname?: string;
    predicate?: (record: WebSocketHandshakeRecord) => boolean;
    timeout: NodeJS.Timeout;
  }> = [];

  wsServer.on("connection", (socket, request) => {
    const record: WebSocketHandshakeRecord = {
      pathname: new URL(request.url || "/", "http://local").pathname,
      headers: request.headers,
    };
    handshakes.push(record);

    const waiters = [...pendingWaiters];
    for (const waiter of waiters) {
      const pathnameOk = waiter.pathname ? waiter.pathname === record.pathname : true;
      const predicateOk = waiter.predicate ? waiter.predicate(record) : true;
      if (!pathnameOk || !predicateOk) continue;
      clearTimeout(waiter.timeout);
      const index = pendingWaiters.indexOf(waiter);
      if (index >= 0) pendingWaiters.splice(index, 1);
      waiter.resolve(record);
    }

    socket.on("message", (raw) => {
      socket.send(`echo:${String(raw)}`);
    });
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    wsServer.close();
    httpServer.close();
    throw new Error("websocket fixture failed to bind");
  }

  return {
    url: `ws://host.docker.internal:${String(address.port)}`,
    async waitForHandshake(options) {
      const timeoutMs = options?.timeoutMs ?? 7_500;
      const existing = handshakes.find((record) => {
        const pathnameOk = options?.pathname ? record.pathname === options.pathname : true;
        const predicateOk = options?.predicate ? options.predicate(record) : true;
        return pathnameOk && predicateOk;
      });
      if (existing) return existing;

      return await new Promise<WebSocketHandshakeRecord>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = pendingWaiters.findIndex((waiter) => waiter.timeout === timeout);
          if (index >= 0) pendingWaiters.splice(index, 1);
          reject(
            new Error(
              `Timed out waiting for websocket handshake pathname=${options?.pathname ?? "(any)"}`,
            ),
          );
        }, timeoutMs);

        pendingWaiters.push({
          resolve,
          reject,
          pathname: options?.pathname,
          predicate: options?.predicate,
          timeout,
        });
      });
    },
    async [Symbol.asyncDispose]() {
      for (const waiter of pendingWaiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("websocket fixture disposed while waiting"));
      }
      wsServer.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

export async function mswProxyFixture(params?: {
  handlers?: MswHandler[];
  onUnhandledRequest?: MswOnUnhandledRequest;
  upstreamOrigin?: string;
}): Promise<MswProxyFixture> {
  const upstreamOrigin = params?.upstreamOrigin ?? "https://upstream.iterate.localhost";
  const onUnhandledRequest = params?.onUnhandledRequest ?? "bypass";
  const requestRecords: MswRequestRecord[] = [];

  let initialHandlers = [...(params?.handlers ?? [])];
  let runtimeHandlers: MswHandler[] = [];

  function activeHandlers(): MswHandler[] {
    return [...runtimeHandlers, ...initialHandlers];
  }

  const app = express();
  app.use(async (req, res, next) => {
    try {
      const targetUrl = new URL(req.url || "/", upstreamOrigin);
      const requestId = randomUUID();
      const requestMethod = req.method || "GET";
      const requestForRecord = new Request(targetUrl.toString(), {
        method: requestMethod,
        headers: new Headers(
          sanitizeHeaders(req.headers as unknown as Record<string, string | string[] | undefined>),
        ),
      });

      requestRecords.push(recordFromEvent("start", requestId, requestForRecord));
      req.url = targetUrl.toString();

      const middleware = createMiddleware(...activeHandlers());
      let passthrough = false;
      let middlewareError: unknown;
      await middleware(req, res, (error?: unknown) => {
        passthrough = true;
        middlewareError = error;
      });

      if (middlewareError) throw middlewareError;

      if (!passthrough) {
        requestRecords.push(recordFromEvent("match", requestId, requestForRecord));
        requestRecords.push(recordFromEvent("end", requestId, requestForRecord));
        return;
      }

      requestRecords.push(recordFromEvent("unhandled", requestId, requestForRecord));
      requestRecords.push(recordFromEvent("end", requestId, requestForRecord));

      const message = `Unhandled request: ${requestMethod} ${targetUrl.toString()}`;
      if (onUnhandledRequest === "error") {
        res.status(500).json({ error: "msw_unhandled_request", message });
        return;
      }

      res.status(404).json({
        error: onUnhandledRequest === "warn" ? "msw_unhandled_request" : "mock_not_found",
        message,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: unknown, res: any, _next: unknown) => {
    res.status(502).json({
      error: "msw_proxy_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  });

  const proxy = app.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  const address = proxy.address();
  if (!address || typeof address === "string") {
    proxy.close();
    throw new Error("proxy address unavailable");
  }

  async function waitForRequest(
    filter: MswRequestFilter,
    options?: WaitForRequestOptions,
  ): Promise<MswRequestRecord> {
    const phase = options?.phase ?? "match";
    const timeoutMs = options?.timeoutMs ?? 7_500;

    const existing = requestRecords.find(
      (record) => record.phase === phase && requestMatches(record, filter),
    );
    if (existing) return existing;

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const current = requestRecords.find(
        (record) => record.phase === phase && requestMatches(record, filter),
      );
      if (current) return current;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const seenForPhase = requestRecords.filter((record) => record.phase === phase);
    throw new Error(
      `Timed out waiting for MSW ${phase} request.\nFilter=${JSON.stringify(
        {
          method: filter.method,
          url: typeof filter.url === "string" ? filter.url : String(filter.url),
          pathname: filter.pathname,
          predicate: Boolean(filter.predicate),
        },
        null,
        2,
      )}\nSeen:\n${summarizeRequestRecords(seenForPhase) || "(none)"}`,
    );
  }

  return {
    proxyUrl: `http://host.docker.internal:${String(address.port)}`,
    hostProxyUrl: `http://127.0.0.1:${String(address.port)}`,
    use(...handlers: MswHandler[]) {
      runtimeHandlers = [...handlers, ...runtimeHandlers];
    },
    resetHandlers(...handlers: MswHandler[]) {
      if (handlers.length > 0) initialHandlers = [...handlers];
      runtimeHandlers = [];
    },
    restoreHandlers() {
      // no-op: fixture uses explicit local handler arrays
    },
    boundary<Args extends Array<unknown>, ReturnValue>(
      callback: (...args: Args) => ReturnValue,
    ): (...args: Args) => ReturnValue {
      return callback;
    },
    listRequests(phase?: MswRequestPhase) {
      if (!phase) return [...requestRecords];
      return requestRecords.filter((record) => record.phase === phase);
    },
    async waitForRequest(filter: MswRequestFilter, options?: WaitForRequestOptions) {
      return await waitForRequest(filter, options);
    },
    async expectRequest(filter: MswRequestFilter, options?: WaitForRequestOptions) {
      return await waitForRequest(filter, options);
    },
    expectNoUnhandledRequests(filter?: MswRequestFilter) {
      const unhandled = requestRecords
        .filter((record) => record.phase === "unhandled")
        .filter((record) => (filter ? requestMatches(record, filter) : true));
      if (unhandled.length > 0) {
        throw new Error(`MSW captured unhandled requests:\n${summarizeRequestRecords(unhandled)}`);
      }
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      });
    },
  };
}

export async function waitForHttpOk(url: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`timed out waiting for healthy endpoint: ${url}`);
}
