import { DockerClient } from "@docker/node-sdk";
import { getLocal, type CompletedRequest, type Mockttp } from "mockttp";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";

type MockttpOnUnhandledRequest = "bypass" | "warn" | "error";

export interface ProxyRequestFilter {
  method?: string;
  url?: string | RegExp | ((url: URL) => boolean);
  pathname?: string | RegExp;
  predicate?: (request: CompletedRequest) => boolean;
}

export interface WaitForRequestOptions {
  timeoutMs?: number;
  source?: "all" | "unhandled";
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

function requestUrl(request: CompletedRequest): URL {
  return new URL(request.url);
}

function requestMatches(request: CompletedRequest, filter: ProxyRequestFilter): boolean {
  if (filter.method && request.method.toUpperCase() !== filter.method.toUpperCase()) return false;
  const url = requestUrl(request);
  if (!urlMatches(url, filter.url)) return false;
  if (!pathnameMatches(url, filter.pathname)) return false;
  if (filter.predicate && !filter.predicate(request)) return false;
  return true;
}

function summarizeRequests(requests: CompletedRequest[]): string {
  return requests.map((request) => `${request.method.toUpperCase()} ${request.url}`).join("\n");
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
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const inspect = await docker.containerInspect(created.Id);
        const mapping = inspect.NetworkSettings?.Ports?.[containerPort];
        const hostPort = mapping?.[0]?.HostPort;
        if (hostPort) return Number(hostPort);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No published port for ${containerPort} on container ${created.Id}`);
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

export interface MockttpProxyFixture extends AsyncDisposable {
  proxyUrl: string;
  hostProxyUrl: string;
  server: Mockttp;
  listRequests(): CompletedRequest[];
  listUnhandledRequests(): CompletedRequest[];
  waitForRequest(
    filter: ProxyRequestFilter,
    options?: WaitForRequestOptions,
  ): Promise<CompletedRequest>;
  expectRequest(
    filter: ProxyRequestFilter,
    options?: WaitForRequestOptions,
  ): Promise<CompletedRequest>;
  expectNoUnhandledRequests(filter?: ProxyRequestFilter): void;
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

export async function mockttpProxyFixture(params?: {
  onUnhandledRequest?: MockttpOnUnhandledRequest;
}): Promise<MockttpProxyFixture> {
  const onUnhandledRequest = params?.onUnhandledRequest ?? "bypass";
  const server = getLocal();
  await server.start();

  const seenRequests: CompletedRequest[] = [];
  const unhandledRequests: CompletedRequest[] = [];

  await server.on("request", (request) => {
    seenRequests.push(request);
  });

  await server
    .forUnmatchedRequest()
    .always()
    .thenCallback((request) => {
      unhandledRequests.push(request);
      const message = `Unhandled request: ${request.method.toUpperCase()} ${request.url}`;
      if (onUnhandledRequest === "error") {
        return {
          statusCode: 500,
          json: { error: "mock_unhandled_request", message },
        };
      }

      return {
        statusCode: 404,
        json: {
          error: onUnhandledRequest === "warn" ? "mock_unhandled_request" : "mock_not_found",
          message,
        },
      };
    });

  async function waitForRequest(
    filter: ProxyRequestFilter,
    options?: WaitForRequestOptions,
  ): Promise<CompletedRequest> {
    const timeoutMs = options?.timeoutMs ?? 7_500;
    const source = options?.source ?? "all";

    const getPool = () => (source === "unhandled" ? unhandledRequests : seenRequests);
    const firstMatch = getPool().find((request) => requestMatches(request, filter));
    if (firstMatch) return firstMatch;

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const match = getPool().find((request) => requestMatches(request, filter));
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(
      `Timed out waiting for ${source} request.\nFilter=${JSON.stringify(
        {
          method: filter.method,
          url: typeof filter.url === "string" ? filter.url : String(filter.url),
          pathname: filter.pathname,
          predicate: Boolean(filter.predicate),
        },
        null,
        2,
      )}\nSeen:\n${summarizeRequests(getPool()) || "(none)"}`,
    );
  }

  return {
    proxyUrl: `http://host.docker.internal:${String(server.port)}`,
    hostProxyUrl: `http://127.0.0.1:${String(server.port)}`,
    server,
    listRequests() {
      return [...seenRequests];
    },
    listUnhandledRequests() {
      return [...unhandledRequests];
    },
    async waitForRequest(filter: ProxyRequestFilter, options?: WaitForRequestOptions) {
      return await waitForRequest(filter, options);
    },
    async expectRequest(filter: ProxyRequestFilter, options?: WaitForRequestOptions) {
      return await waitForRequest(filter, options);
    },
    expectNoUnhandledRequests(filter?: ProxyRequestFilter) {
      const unmatched = unhandledRequests.filter((request) =>
        filter ? requestMatches(request, filter) : true,
      );
      if (unmatched.length > 0) {
        throw new Error(`Mockttp captured unmatched requests:\n${summarizeRequests(unmatched)}`);
      }
    },
    async [Symbol.asyncDispose]() {
      await server.stop();
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
