#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectDeployment, type ProjectDeployment } from "../e2e/test-helpers/index.ts";
import { ON_DEMAND_OTEL_SERVICE_ENV, ON_DEMAND_PROCESSES } from "../shared/on-demand-processes.ts";
import type {
  DemoEvent,
  EgressRecord,
  JonaslandDemoMutation,
  JonaslandDemoMutationResult,
  JonaslandDemoProvider,
  JonaslandDemoState,
  JonaslandMockRule,
  SimulateSlackInput,
  SimulateSlackResult,
} from "./src/types.ts";

const execFileAsync = promisify(execFile);

type RouteCheck = {
  host: string;
  path: string;
  timeoutMs?: number;
};

type DirectHttpCheck = {
  url: string;
  timeoutMs?: number;
};

type ProcessConfig = {
  slug: string;
  definition: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  routeCheck?: RouteCheck;
  directHttpCheck?: DirectHttpCheck;
};

type OrpcEnvelope<T> = { json: T };

type UpsertMockRuleInput = {
  id?: string;
  name: string;
  enabled?: boolean;
  method: string;
  hostPattern: string;
  pathPattern: string;
  responseStatus: number;
  responseHeaders?: Record<string, string>;
  responseBody: string;
};

type ProxyResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const MAX_RECORDS = 300;
const MAX_EVENTS = 300;
const DEFAULT_ORPC_TIMEOUT_MS = 90_000;

const apiPort = Number.parseInt(process.env.JONASLAND_DEMO_API_PORT ?? "19099", 10);
const repoRootPath = fileURLToPath(new URL("../..", import.meta.url));
const sandboxImage = process.env.JONASLAND_SANDBOX_IMAGE ?? "jonasland-sandbox:local";
const externalEgressProxy =
  process.env.JONASLAND_DEMO_EGRESS_PROXY ?? `http://host.docker.internal:${String(apiPort)}`;

const configuredProvider = process.env.JONASLAND_DEMO_PROVIDER?.trim();
const initialProvider: JonaslandDemoProvider =
  configuredProvider === "fly" || configuredProvider === "docker" ? configuredProvider : "docker";

const onDemandProcesses: ProcessConfig[] = ON_DEMAND_PROCESSES.map((processConfig) => ({
  slug: processConfig.slug,
  definition: processConfig.definition,
  ...(processConfig.routeCheck
    ? {
        routeCheck: {
          ...processConfig.routeCheck,
          timeoutMs: processConfig.routeCheck.timeoutMs ?? 60_000,
        },
      }
    : {}),
  ...(processConfig.directHttpCheck
    ? {
        directHttpCheck: {
          ...processConfig.directHttpCheck,
          timeoutMs: processConfig.directHttpCheck.timeoutMs ?? 60_000,
        },
      }
    : {}),
}));

const homeProcess: ProcessConfig = {
  slug: "home",
  definition: {
    command: "/opt/pidnap/node_modules/.bin/tsx",
    args: ["/opt/services/home-service/src/server.ts"],
    env: ON_DEMAND_OTEL_SERVICE_ENV,
  },
  routeCheck: { host: "home.iterate.localhost", path: "/", timeoutMs: 60_000 },
};

const state: JonaslandDemoState = {
  provider: initialProvider,
  phase: "idle",
  busy: false,
  lastError: null,
  sandbox: {
    image: sandboxImage,
    containerName: null,
    ingressUrl: null,
    externalEgressProxy,
  },
  links: {
    home: null,
  },
  config: {
    defaultSlackPrompt: "<@BOT> what is 50 minus 8",
    fallbackMode: "deny-all",
    mockRules: [
      {
        id: "rule-openai-responses",
        name: "OpenAI responses",
        enabled: true,
        method: "POST",
        hostPattern: "*",
        pathPattern: "/v1/responses",
        responseStatus: 200,
        responseHeaders: {
          "content-type": "application/json; charset=utf-8",
        },
        responseBody: JSON.stringify(
          {
            id: "resp_demo",
            object: "response",
            status: "completed",
            model: "gpt-4o-mini",
            output_text: "The answer is 42",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "The answer is 42" }],
              },
            ],
          },
          null,
          2,
        ),
      },
      {
        id: "rule-slack-post-message",
        name: "Slack chat.postMessage",
        enabled: true,
        method: "POST",
        hostPattern: "*",
        pathPattern: "/api/chat.postMessage",
        responseStatus: 200,
        responseHeaders: {
          "content-type": "application/json; charset=utf-8",
        },
        responseBody: JSON.stringify(
          {
            ok: true,
            ts: "123.456",
          },
          null,
          2,
        ),
      },
    ],
  },
  records: [],
  events: [],
};

let deployment: ProjectDeployment | null = null;
let activeOperation: Promise<unknown> | null = null;
const stateSubscribers = new Map<
  string,
  {
    res: ServerResponse;
    heartbeat: NodeJS.Timeout;
  }
>();

function nowIso(): string {
  return new Date().toISOString();
}

function snapshotState(): JonaslandDemoState {
  return {
    ...state,
    sandbox: { ...state.sandbox },
    links: { ...state.links },
    config: {
      ...state.config,
      mockRules: state.config.mockRules.map((rule) => ({
        ...rule,
        responseHeaders: { ...rule.responseHeaders },
      })),
    },
    records: state.records.map((record) => ({
      ...record,
      headers: { ...record.headers },
      responseHeaders: { ...record.responseHeaders },
    })),
    events: state.events.map((event) => ({ ...event })),
  };
}

function emitStateSnapshotToSubscriber(res: ServerResponse, snapshot: JonaslandDemoState): void {
  const payload = JSON.stringify({ json: snapshot });
  res.write(`event: message\ndata: ${payload}\n\n`);
}

function publishStateUpdate(): void {
  if (stateSubscribers.size === 0) return;

  const snapshot = snapshotState();
  for (const [subscriberId, subscriber] of stateSubscribers) {
    if (subscriber.res.writableEnded || subscriber.res.destroyed) {
      clearInterval(subscriber.heartbeat);
      stateSubscribers.delete(subscriberId);
      continue;
    }

    try {
      emitStateSnapshotToSubscriber(subscriber.res, snapshot);
    } catch {
      clearInterval(subscriber.heartbeat);
      stateSubscribers.delete(subscriberId);
      subscriber.res.destroy();
    }
  }
}

function attachStateUpdatesStream(req: IncomingMessage, res: ServerResponse): void {
  setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const subscriberId = randomUUID();
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": ping\n\n");
  }, 15_000);

  stateSubscribers.set(subscriberId, { res, heartbeat });
  emitStateSnapshotToSubscriber(res, snapshotState());

  req.on("close", () => {
    clearInterval(heartbeat);
    stateSubscribers.delete(subscriberId);
    if (!res.writableEnded) {
      res.end();
    }
  });
}

function appendEvent(message: string): void {
  const event: DemoEvent = {
    id: randomUUID(),
    createdAt: nowIso(),
    message,
  };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  process.stdout.write(`[jonasland-demo] ${event.createdAt} ${message}\n`);
  publishStateUpdate();
}

function syncLinksFromIngress(): void {
  if (state.sandbox.ingressUrl === null) {
    state.links.home = null;
    return;
  }

  const parsed = new URL(state.sandbox.ingressUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  state.links.home = `http://home.iterate.localhost:${port}/`;
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  setCors(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function sendOrpcJson<T>(res: ServerResponse, status: number, value: T): void {
  sendJson(res, status, { json: value } satisfies OrpcEnvelope<T>);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function toHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value as string | string[]]),
  );
}

function sanitizeResponseHeaders(
  headers: Record<string, string | number | string[] | undefined>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    next[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return next;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  return (body.length > 0 ? JSON.parse(body) : {}) as T;
}

function recordEgress(entry: EgressRecord): void {
  state.records.push(entry);
  if (state.records.length > MAX_RECORDS) {
    state.records.splice(0, state.records.length - MAX_RECORDS);
  }
  publishStateUpdate();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePath(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

async function waitForHostRoute(
  sandbox: ProjectDeployment,
  params: { host: string; path: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await sandbox
      .exec([
        "curl",
        "-fsS",
        "-H",
        `Host: ${params.host}`,
        `http://127.0.0.1${normalizePath(params.path)}`,
      ])
      .catch(() => ({ exitCode: 1, output: "" }));

    if (result.exitCode === 0) return;
    await sleep(250);
  }

  throw new Error(`timed out waiting for route ${params.host}${normalizePath(params.path)}`);
}

async function waitForDirectHttp(
  sandbox: ProjectDeployment,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await sandbox.exec(["curl", "-fsS", params.url]).catch(() => ({
      exitCode: 1,
      output: "",
    }));
    if (result.exitCode === 0) return;
    await sleep(250);
  }

  throw new Error(`timed out waiting for direct http ${params.url}`);
}

async function startProcess(sandbox: ProjectDeployment, config: ProcessConfig): Promise<void> {
  appendEvent(`starting process: ${config.slug}`);

  const updated = await sandbox.pidnap.processes.updateConfig({
    processSlug: config.slug,
    definition: config.definition,
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });

  if (updated.state !== "running") {
    await sandbox.pidnap.processes.start({ target: config.slug });
  }

  await sandbox.waitForPidnapProcessRunning({
    target: config.slug,
    timeoutMs: 120_000,
  });

  if (config.routeCheck) {
    await waitForHostRoute(sandbox, config.routeCheck);
  }

  if (config.directHttpCheck) {
    await waitForDirectHttp(sandbox, config.directHttpCheck);
  }

  appendEvent(`process ready: ${config.slug}`);
}

async function bodyInitToString(
  body: RequestInit["body"] | null | undefined,
): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return await body.text();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf-8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf-8");
  }
  if (body instanceof ReadableStream) {
    const response = new Response(body);
    return await response.text();
  }
  const response = new Response(body);
  return await response.text();
}

async function hostRequest(
  targetIngressUrl: string,
  host: string,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(normalizePath(pathname), targetIngressUrl);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  headers.set("host", host);
  headers.delete("content-length");

  const body = await bodyInitToString(init?.body);
  if (body !== undefined) {
    headers.set("content-length", Buffer.byteLength(body, "utf8").toString());
  }

  return await new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method,
        headers: Object.fromEntries(headers.entries()),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("error", reject);
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
              continue;
            }
            responseHeaders.set(key, String(value));
          }

          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        });
      },
    );

    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

async function withOperationLock<Result>(task: () => Promise<Result>): Promise<Result> {
  if (activeOperation !== null) {
    throw new Error("another operation is already running");
  }

  state.busy = true;
  publishStateUpdate();
  const operation = task();
  activeOperation = operation;

  try {
    return await operation;
  } finally {
    if (activeOperation === operation) {
      activeOperation = null;
      state.busy = false;
      publishStateUpdate();
    }
  }
}

async function startSandbox(): Promise<void> {
  if (state.provider === "fly") {
    throw new Error("fly provider is not implemented yet");
  }

  if (deployment !== null && state.phase === "running") {
    appendEvent("sandbox already running; skipping start");
    return;
  }

  if (deployment !== null) {
    appendEvent("cleaning up stale sandbox before start");
    await deployment[Symbol.asyncDispose]().catch(() => {});
    deployment = null;
    state.sandbox.containerName = null;
    state.sandbox.ingressUrl = null;
    syncLinksFromIngress();
  }

  state.phase = "starting";
  state.lastError = null;

  let sandbox: ProjectDeployment | null = null;
  let nextContainerName: string | null = null;

  try {
    appendEvent(`building image: ${state.sandbox.image}`);
    await execFileAsync("pnpm", ["--filter", "./jonasland/sandbox", "build"], {
      cwd: repoRootPath,
    });

    nextContainerName = `jonasland-demo-ui-${randomUUID().slice(0, 8)}`;
    appendEvent(`starting container: ${nextContainerName}`);

    sandbox = await projectDeployment({
      image: state.sandbox.image,
      name: nextContainerName,
      capAdd: ["NET_ADMIN", "SYS_ADMIN"],
      extraHosts: ["host.docker.internal:host-gateway"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: state.sandbox.externalEgressProxy,
      },
    });
    const nextIngressUrl = await sandbox.ingressUrl();

    appendEvent("ensuring baseline processes");
    for (const processSlug of ["caddy", "registry", "events", "daemon"] as const) {
      await sandbox.waitForPidnapProcessRunning({ target: processSlug, timeoutMs: 120_000 });
    }

    await startProcess(sandbox, homeProcess);

    for (const processConfig of onDemandProcesses) {
      await startProcess(sandbox, processConfig);
    }

    deployment = sandbox;
    state.sandbox.containerName = nextContainerName;
    state.sandbox.ingressUrl = nextIngressUrl;
    syncLinksFromIngress();
    state.phase = "running";
    appendEvent(`sandbox ready at ${nextIngressUrl}`);
  } catch (error) {
    await sandbox?.[Symbol.asyncDispose]().catch(() => {});
    deployment = null;
    state.sandbox.containerName = null;
    state.sandbox.ingressUrl = null;
    syncLinksFromIngress();
    state.phase = "error";
    state.lastError = errorMessage(error);
    appendEvent(`sandbox start failed: ${state.lastError.split("\n")[0] ?? "unknown error"}`);
    throw error;
  }
}

async function stopSandbox(): Promise<void> {
  if (deployment === null) {
    state.phase = "idle";
    state.sandbox.containerName = null;
    state.sandbox.ingressUrl = null;
    syncLinksFromIngress();
    appendEvent("sandbox not running; nothing to stop");
    return;
  }

  state.phase = "stopping";
  appendEvent(`stopping container: ${state.sandbox.containerName ?? "unknown"}`);

  const currentDeployment = deployment;
  try {
    await currentDeployment[Symbol.asyncDispose]();
    appendEvent("sandbox stopped");
  } catch (error) {
    state.lastError = errorMessage(error);
    appendEvent(`sandbox stop failed: ${state.lastError.split("\n")[0] ?? "unknown error"}`);
  } finally {
    deployment = null;
    state.sandbox.containerName = null;
    state.sandbox.ingressUrl = null;
    syncLinksFromIngress();
    state.phase = "idle";
  }
}

async function simulateSlackWebhook(payload: SimulateSlackInput): Promise<SimulateSlackResult> {
  if (state.sandbox.ingressUrl === null) {
    throw new Error("sandbox is not running");
  }

  const threadTs = payload.threadTs ?? `${Math.floor(Date.now() / 1000)}.000100`;
  const channel = payload.channel ?? "C_DEMO";
  const text = payload.text ?? state.config.defaultSlackPrompt;

  const response = await hostRequest(
    state.sandbox.ingressUrl,
    "slack.iterate.localhost",
    "/webhook",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          type: "app_mention",
          user: "U_DEMO",
          text,
          channel,
          ts: threadTs,
          thread_ts: threadTs,
        },
      }),
    },
  );

  const body = await response.text();
  appendEvent(`simulate slack webhook -> status ${String(response.status)}`);

  return {
    status: response.status,
    ok: response.ok,
    body,
    threadTs,
    channel,
    text,
  };
}

async function streamDaemonCommandToClient(params: {
  req: IncomingMessage;
  res: ServerResponse;
  command: string;
  cwd?: string;
}): Promise<void> {
  const ingressUrl = state.sandbox.ingressUrl;
  if (ingressUrl === null) {
    sendJson(params.res, 400, { error: "sandbox is not running" });
    return;
  }

  const target = new URL("/orpc/tools/streamShell", ingressUrl);
  const body = JSON.stringify({
    json: {
      command: params.command,
      ...(params.cwd ? { cwd: params.cwd } : {}),
    },
  });

  await new Promise<void>((resolve, reject) => {
    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: target.pathname,
        headers: {
          host: "daemon.iterate.localhost",
          accept: "text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body, "utf8").toString(),
        },
      },
      (upstreamResponse) => {
        setCors(params.res);
        params.res.writeHead(upstreamResponse.statusCode ?? 200, {
          "content-type": String(
            upstreamResponse.headers["content-type"] ?? "text/plain; charset=utf-8",
          ),
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        });

        upstreamResponse.on("data", (chunk) => {
          params.res.write(chunk);
        });

        upstreamResponse.on("end", () => {
          params.res.end();
          resolve();
        });

        upstreamResponse.on("error", (error) => {
          reject(error);
        });
      },
    );

    upstream.on("error", reject);
    params.req.on("close", () => {
      upstream.destroy();
      if (!params.res.writableEnded) {
        params.res.end();
      }
      resolve();
    });
    upstream.write(body);
    upstream.end();
  });
}

function wildcardMatch(value: string, pattern: string): boolean {
  const normalized = pattern.trim();
  if (normalized.length === 0 || normalized === "*") return true;

  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(value);
}

function findMatchingMockRule(params: {
  method: string;
  host: string;
  path: string;
}): JonaslandMockRule | undefined {
  const pathOnly = params.path.split("?")[0];
  return state.config.mockRules.find((rule) => {
    if (!rule.enabled) return false;

    const methodMatch = wildcardMatch(params.method, rule.method);
    const hostMatch = wildcardMatch(params.host, rule.hostPattern);
    const pathMatch = wildcardMatch(pathOnly, rule.pathPattern);

    return methodMatch && hostMatch && pathMatch;
  });
}

function hopByHopHeader(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    lowered === "host" ||
    lowered === "connection" ||
    lowered === "proxy-connection" ||
    lowered === "keep-alive" ||
    lowered === "transfer-encoding" ||
    lowered === "te" ||
    lowered === "trailer" ||
    lowered === "upgrade" ||
    lowered === "content-length"
  );
}

function buildForwardHeaders(incoming: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || hopByHopHeader(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

function parseTargetUrl(pathnameWithQuery: string, host: string): URL {
  if (pathnameWithQuery.startsWith("http://") || pathnameWithQuery.startsWith("https://")) {
    return new URL(pathnameWithQuery);
  }

  return new URL(pathnameWithQuery, `https://${host}`);
}

async function proxyToInternet(params: {
  request: IncomingMessage;
  requestBody: string;
  host: string;
  pathnameWithQuery: string;
}): Promise<ProxyResult> {
  const method = (params.request.method ?? "GET").toUpperCase();
  const headers = buildForwardHeaders(params.request.headers);
  const hasBody = method !== "GET" && method !== "HEAD";
  const requestBody = hasBody ? params.requestBody : undefined;

  const primaryTarget = parseTargetUrl(params.pathnameWithQuery, params.host);
  const candidates = [primaryTarget];

  if (
    !params.pathnameWithQuery.startsWith("http://") &&
    !params.pathnameWithQuery.startsWith("https://") &&
    primaryTarget.protocol === "https:"
  ) {
    const fallback = new URL(primaryTarget.toString());
    fallback.protocol = "http:";
    candidates.push(fallback);
  }

  let lastError: unknown;
  for (const target of candidates) {
    try {
      const response = await fetch(target, {
        method,
        headers,
        body: requestBody,
      });

      const responseBody = await response.text();
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding") continue;
        responseHeaders[key] = value;
      }

      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`proxy to internet failed: ${errorMessage(lastError)}`);
}

function jsonString(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseSafeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function parseOrpcProcedure(pathname: string): string | null {
  if (!pathname.startsWith("/orpc/")) return null;
  const procedure = pathname.slice("/orpc/".length);
  return procedure.length > 0 ? procedure : null;
}

async function parseOrpcInput(req: IncomingMessage): Promise<unknown> {
  const payload = await readJson<unknown>(req).catch(() => ({}));
  if (!isRecord(payload)) return {};
  if ("json" in payload) {
    return (payload as { json?: unknown }).json ?? {};
  }
  return payload;
}

function asProvider(input: unknown): JonaslandDemoProvider {
  if (input === "docker" || input === "fly") return input;
  throw new Error("provider must be 'docker' or 'fly'");
}

function sanitizeMockRuleInput(input: unknown): UpsertMockRuleInput {
  if (!isRecord(input)) throw new Error("mock rule payload must be an object");

  const name = readString(input, "name")?.trim();
  const method = readString(input, "method")?.trim().toUpperCase();
  const hostPattern = readString(input, "hostPattern")?.trim();
  const pathPattern = readString(input, "pathPattern")?.trim();
  const responseStatus = readNumber(input, "responseStatus");
  const responseBody = readString(input, "responseBody");
  const validStatus =
    typeof responseStatus === "number" &&
    Number.isInteger(responseStatus) &&
    responseStatus >= 100 &&
    responseStatus <= 599
      ? responseStatus
      : null;

  if (!name) throw new Error("name is required");
  if (!method) throw new Error("method is required");
  if (!hostPattern) throw new Error("hostPattern is required");
  if (!pathPattern) throw new Error("pathPattern is required");
  if (validStatus === null) {
    throw new Error("responseStatus must be an integer between 100 and 599");
  }
  if (responseBody === undefined) throw new Error("responseBody is required");

  const rawHeaders = input.responseHeaders;
  const responseHeaders: Record<string, string> = {};
  if (isRecord(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") {
        responseHeaders[key] = value;
      }
    }
  }

  return {
    id: readString(input, "id")?.trim(),
    name,
    enabled: readBoolean(input, "enabled"),
    method,
    hostPattern,
    pathPattern,
    responseStatus: validStatus,
    responseHeaders,
    responseBody,
  };
}

async function applyStateMutation(
  input: JonaslandDemoMutation,
): Promise<JonaslandDemoMutationResult> {
  if (input.type === "set-provider") {
    if (state.phase !== "idle") {
      throw new Error("provider can only be changed while sandbox is idle");
    }

    state.provider = input.provider;
    appendEvent(`provider set to ${state.provider}`);
    return { state: snapshotState() };
  }

  if (input.type === "start-sandbox") {
    await withOperationLock(async () => await startSandbox());
    publishStateUpdate();
    return { state: snapshotState() };
  }

  if (input.type === "stop-sandbox") {
    await withOperationLock(async () => await stopSandbox());
    publishStateUpdate();
    return { state: snapshotState() };
  }

  if (input.type === "simulate-slack-webhook") {
    const result = await withOperationLock(async () => await simulateSlackWebhook(input.input));
    publishStateUpdate();
    return { state: snapshotState(), result };
  }

  if (input.type === "patch-config") {
    if (input.patch.defaultSlackPrompt !== undefined) {
      state.config.defaultSlackPrompt = input.patch.defaultSlackPrompt;
    }

    if (input.patch.fallbackMode !== undefined) {
      if (
        input.patch.fallbackMode !== "deny-all" &&
        input.patch.fallbackMode !== "proxy-internet"
      ) {
        throw new Error("fallbackMode must be 'deny-all' or 'proxy-internet'");
      }
      state.config.fallbackMode = input.patch.fallbackMode;
    }

    appendEvent("updated demo config");
    return { state: snapshotState() };
  }

  if (input.type === "upsert-mock-rule") {
    const next = sanitizeMockRuleInput(input.rule);
    const ruleId = next.id && next.id.length > 0 ? next.id : `rule-${randomUUID()}`;

    const rule: JonaslandMockRule = {
      id: ruleId,
      name: next.name,
      enabled: next.enabled ?? true,
      method: next.method,
      hostPattern: next.hostPattern,
      pathPattern: next.pathPattern,
      responseStatus: next.responseStatus,
      responseHeaders: next.responseHeaders ?? {},
      responseBody: next.responseBody,
    };

    const existingIndex = state.config.mockRules.findIndex((entry) => entry.id === ruleId);
    if (existingIndex >= 0) {
      state.config.mockRules[existingIndex] = rule;
      appendEvent(`updated mock rule: ${rule.name}`);
    } else {
      state.config.mockRules.push(rule);
      appendEvent(`added mock rule: ${rule.name}`);
    }

    return { state: snapshotState() };
  }

  if (input.type === "delete-mock-rule") {
    const id = input.id.trim();
    if (!id) throw new Error("id is required");

    const prevLength = state.config.mockRules.length;
    state.config.mockRules = state.config.mockRules.filter((rule) => rule.id !== id);
    if (state.config.mockRules.length !== prevLength) {
      appendEvent(`deleted mock rule: ${id}`);
    }

    return { state: snapshotState() };
  }

  if (input.type === "clear-records") {
    state.records = [];
    appendEvent("cleared egress records");
    return { state: snapshotState() };
  }

  const exhaustiveCheck: never = input;
  throw new Error(`unsupported mutation: ${JSON.stringify(exhaustiveCheck)}`);
}

function parseStateMutation(input: unknown): JonaslandDemoMutation {
  if (!isRecord(input)) throw new Error("mutation payload must be an object");

  const mutationType = readString(input, "type");
  if (!mutationType) throw new Error("mutation type is required");

  if (mutationType === "set-provider") {
    return { type: mutationType, provider: asProvider(input.provider) };
  }

  if (mutationType === "start-sandbox" || mutationType === "stop-sandbox") {
    return { type: mutationType };
  }

  if (mutationType === "simulate-slack-webhook") {
    const rawInput = isRecord(input.input) ? input.input : {};
    return {
      type: mutationType,
      input: {
        text: readString(rawInput, "text"),
        channel: readString(rawInput, "channel"),
        threadTs: readString(rawInput, "threadTs"),
      },
    };
  }

  if (mutationType === "patch-config") {
    const rawPatch = isRecord(input.patch) ? input.patch : {};
    return {
      type: mutationType,
      patch: {
        defaultSlackPrompt: readString(rawPatch, "defaultSlackPrompt"),
        fallbackMode: readString(rawPatch, "fallbackMode") as
          | "deny-all"
          | "proxy-internet"
          | undefined,
      },
    };
  }

  if (mutationType === "upsert-mock-rule") {
    const rawRule = isRecord(input.rule) ? input.rule : input;
    return {
      type: mutationType,
      rule: sanitizeMockRuleInput(rawRule),
    };
  }

  if (mutationType === "delete-mock-rule") {
    const id = readString(input, "id")?.trim();
    if (!id) throw new Error("id is required");
    return { type: mutationType, id };
  }

  if (mutationType === "clear-records") {
    return { type: mutationType };
  }

  throw new Error(`unknown mutation type: ${mutationType}`);
}

async function dispatchOrpcProcedure(procedure: string, input: unknown): Promise<unknown> {
  const normalizedProcedure = procedure.replaceAll("/", ".");

  if (normalizedProcedure === "demo.getState") {
    return snapshotState();
  }

  if (normalizedProcedure === "demo.mutateState") {
    const mutation = parseStateMutation(input);
    return await applyStateMutation(mutation);
  }

  // Compatibility aliases while frontend/backends move to demo.mutateState.
  if (normalizedProcedure === "demo.setProvider") {
    const payload = isRecord(input) ? input : {};
    return await applyStateMutation({
      type: "set-provider",
      provider: asProvider(payload.provider),
    });
  }

  if (normalizedProcedure === "demo.startSandbox") {
    return await applyStateMutation({ type: "start-sandbox" });
  }

  if (normalizedProcedure === "demo.stopSandbox") {
    return await applyStateMutation({ type: "stop-sandbox" });
  }

  if (normalizedProcedure === "demo.simulateSlackWebhook") {
    const payload = isRecord(input) ? input : {};
    return await applyStateMutation({
      type: "simulate-slack-webhook",
      input: {
        text: readString(payload, "text"),
        channel: readString(payload, "channel"),
        threadTs: readString(payload, "threadTs"),
      },
    });
  }

  if (normalizedProcedure === "demo.patchConfig") {
    const payload = isRecord(input) ? input : {};
    return await applyStateMutation({
      type: "patch-config",
      patch: {
        defaultSlackPrompt: readString(payload, "defaultSlackPrompt"),
        fallbackMode: readString(payload, "fallbackMode") as
          | "deny-all"
          | "proxy-internet"
          | undefined,
      },
    });
  }

  if (normalizedProcedure === "demo.upsertMockRule") {
    return await applyStateMutation({
      type: "upsert-mock-rule",
      rule: sanitizeMockRuleInput(input),
    });
  }

  if (normalizedProcedure === "demo.deleteMockRule") {
    const payload = isRecord(input) ? input : {};
    const id = readString(payload, "id")?.trim();
    if (!id) throw new Error("id is required");
    return await applyStateMutation({ type: "delete-mock-rule", id });
  }

  if (normalizedProcedure === "demo.clearRecords") {
    return await applyStateMutation({ type: "clear-records" });
  }

  throw new Error(`unknown procedure: ${procedure}`);
}

function isInternalPath(pathname: string): boolean {
  return (
    pathname.startsWith("/__demo") ||
    pathname.startsWith("/orpc/") ||
    pathname === "/records" ||
    pathname === "/records/clear" ||
    pathname === "/healthz"
  );
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathnameWithQuery = `${url.pathname}${url.search}`;

  if (method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, phase: state.phase });
      return;
    }

    if (
      (method === "GET" || method === "POST") &&
      (url.pathname === "/orpc/demo.stateUpdates" || url.pathname === "/orpc/demo/stateUpdates")
    ) {
      attachStateUpdatesStream(req, res);
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/orpc/")) {
      const procedure = parseOrpcProcedure(url.pathname);
      if (!procedure) {
        sendJson(res, 404, { error: "procedure not found" });
        return;
      }

      const input = await parseOrpcInput(req);
      const timeout = setTimeout(() => {
        if (!res.headersSent) {
          sendJson(res, 504, {
            error: `procedure timeout after ${String(DEFAULT_ORPC_TIMEOUT_MS)}ms`,
          });
        }
      }, DEFAULT_ORPC_TIMEOUT_MS);

      try {
        const output = await dispatchOrpcProcedure(procedure, input);
        clearTimeout(timeout);
        if (!res.headersSent) {
          sendOrpcJson(res, 200, output);
        }
      } catch (error) {
        clearTimeout(timeout);
        if (!res.headersSent) {
          const message = errorMessage(error);
          state.lastError = message;
          appendEvent(`orpc error (${procedure}): ${message.split("\n")[0] ?? "unknown error"}`);
          sendJson(res, 400, { error: message });
        }
      }
      return;
    }

    if (method === "GET" && url.pathname === "/records") {
      sendJson(res, 200, { total: state.records.length, records: state.records });
      return;
    }

    if (method === "POST" && url.pathname === "/records/clear") {
      await dispatchOrpcProcedure("demo.mutateState", { type: "clear-records" });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/__demo/state") {
      sendJson(res, 200, snapshotState());
      return;
    }

    if (method === "GET" && url.pathname === "/__demo/events") {
      sendJson(res, 200, { total: state.events.length, events: state.events });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/config") {
      const input = await readJson<unknown>(req);
      await dispatchOrpcProcedure("demo.mutateState", {
        type: "patch-config",
        patch: input,
      });
      sendJson(res, 200, { ok: true, state: snapshotState() });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/actions/start") {
      await dispatchOrpcProcedure("demo.mutateState", { type: "start-sandbox" });
      sendJson(res, 200, { ok: true, state: snapshotState() });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/actions/stop") {
      await dispatchOrpcProcedure("demo.mutateState", { type: "stop-sandbox" });
      sendJson(res, 200, { ok: true, state: snapshotState() });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/actions/simulate-slack") {
      const payload = await readJson<unknown>(req);
      const result = await dispatchOrpcProcedure("demo.mutateState", {
        type: "simulate-slack-webhook",
        input: payload,
      });
      sendJson(res, 200, { ok: true, ...(isRecord(result) ? result : { result }) });
      return;
    }

    if (method === "GET" && url.pathname === "/__demo/streams/daemon-logs") {
      const command = url.searchParams.get("command")?.trim();
      const cwd = url.searchParams.get("cwd")?.trim();
      if (!command) {
        sendJson(res, 400, { error: "command query param is required" });
        return;
      }

      appendEvent(`stream daemon logs: ${command}`);
      await streamDaemonCommandToClient({
        req,
        res,
        command,
        ...(cwd ? { cwd } : {}),
      });
      return;
    }

    if (isInternalPath(url.pathname)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const requestBody = await readBody(req);
    const startedAt = Date.now();

    const response = await (async (): Promise<ProxyResult> => {
      const matchedRule = findMatchingMockRule({
        method: (method ?? "GET").toUpperCase(),
        host: req.headers.host ?? "",
        path: pathnameWithQuery,
      });

      if (matchedRule) {
        return {
          status: matchedRule.responseStatus,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...matchedRule.responseHeaders,
          },
          body: matchedRule.responseBody,
        };
      }

      if (state.config.fallbackMode === "deny-all") {
        return {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: jsonString({
            error: "egress_denied",
            message: "No mock rule matched and fallback mode is deny-all",
            request: {
              method,
              host: req.headers.host ?? "",
              path: pathnameWithQuery,
              body: parseSafeJson(requestBody),
            },
          }),
        };
      }

      return await proxyToInternet({
        request: req,
        requestBody,
        host: req.headers.host ?? "",
        pathnameWithQuery,
      });
    })();

    const record: EgressRecord = {
      id: randomUUID(),
      method,
      path: pathnameWithQuery,
      host: req.headers.host ?? "",
      headers: toHeaders(req.headers),
      requestBody,
      responseStatus: response.status,
      responseHeaders: sanitizeResponseHeaders(response.headers),
      responseBody: response.body,
      createdAt: nowIso(),
      durationMs: Date.now() - startedAt,
    };

    recordEgress(record);

    setCors(res);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  } catch (error) {
    const message = errorMessage(error);
    state.lastError = message;
    appendEvent(`error: ${message.split("\n")[0] ?? "unknown error"}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

const shutdown = async () => {
  appendEvent("shutting down");
  if (deployment !== null) {
    await stopSandbox().catch(() => {});
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
};

server.listen(apiPort, "0.0.0.0", () => {
  appendEvent(`demo api + mock egress listening on http://0.0.0.0:${String(apiPort)}`);
  appendEvent(`provider: ${state.provider}`);
  appendEvent(`fallback mode: ${state.config.fallbackMode}`);
});

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
