import { DockerClient } from "@docker/node-sdk";
import { setupServer, type SetupServerApi } from "msw/node";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";

type MswHandler = Parameters<SetupServerApi["use"]>[number];
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

const requestEventNameByPhase: Record<
  MswRequestPhase,
  "request:start" | "request:match" | "request:unhandled" | "request:end"
> = {
  start: "request:start",
  match: "request:match",
  unhandled: "request:unhandled",
  end: "request:end",
};

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
  const server = setupServer(...(params?.handlers ?? []));
  const requestRecords: MswRequestRecord[] = [];

  (Object.keys(requestEventNameByPhase) as MswRequestPhase[]).forEach((phase) => {
    const eventName = requestEventNameByPhase[phase];
    server.events.on(eventName, ({ request, requestId }) => {
      requestRecords.push(recordFromEvent(phase, requestId, request));
    });
  });

  server.listen({ onUnhandledRequest: params?.onUnhandledRequest ?? "bypass" });

  const proxy = createServer(async (req, res) => {
    const targetUrl = new URL(req.url || "/", upstreamOrigin);
    const bodyParts: Buffer[] = [];
    for await (const chunk of req) {
      bodyParts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const init: RequestInit = {
      method: req.method,
      headers: sanitizeHeaders(req.headers),
      redirect: "manual",
    };

    if (bodyParts.length > 0) {
      init.body = Buffer.concat(bodyParts);
    }

    const upstream = await fetch(targetUrl, init);
    const responseHeaders = sanitizeHeaders(upstream.headers);
    const responseBody = Buffer.from(await upstream.arrayBuffer());

    res.writeHead(upstream.status, responseHeaders);
    res.end(responseBody);
  });

  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  const address = proxy.address();
  if (!address || typeof address === "string") {
    proxy.close();
    server.close();
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

    return await new Promise<MswRequestRecord>((resolve, reject) => {
      const eventName = requestEventNameByPhase[phase];
      const listener = ({ request, requestId }: { request: Request; requestId: string }) => {
        const record = recordFromEvent(phase, requestId, request);
        if (!requestMatches(record, filter)) return;
        clearTimeout(timeout);
        server.events.removeListener(eventName, listener);
        resolve(record);
      };

      const timeout = setTimeout(() => {
        server.events.removeListener(eventName, listener);
        const seenForPhase = requestRecords.filter((record) => record.phase === phase);
        reject(
          new Error(
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
          ),
        );
      }, timeoutMs);

      server.events.on(eventName, listener);
    });
  }

  return {
    proxyUrl: `http://host.docker.internal:${String(address.port)}`,
    use(...handlers: MswHandler[]) {
      server.use(...handlers);
    },
    resetHandlers(...handlers: MswHandler[]) {
      server.resetHandlers(...handlers);
    },
    restoreHandlers() {
      server.restoreHandlers();
    },
    boundary<Args extends Array<unknown>, ReturnValue>(
      callback: (...args: Args) => ReturnValue,
    ): (...args: Args) => ReturnValue {
      return server.boundary(callback);
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
      proxy.close();
      await once(proxy, "close").catch(() => undefined);
      server.close();
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
