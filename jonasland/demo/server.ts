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

type RuntimePhase = "idle" | "starting" | "running" | "stopping" | "error";

type MockConfig = {
  openaiOutputText: string;
  openaiModel: string;
  slackResponseOk: boolean;
  slackResponseTs: string;
  defaultSlackPrompt: string;
};

type EgressRecord = {
  id: string;
  method: string;
  path: string;
  host: string;
  headers: Record<string, string | string[]>;
  requestBody: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  createdAt: string;
  durationMs: number;
};

type DemoEvent = {
  id: string;
  createdAt: string;
  message: string;
};

const MAX_RECORDS = 300;
const MAX_EVENTS = 300;

const apiPort = Number.parseInt(process.env.JONASLAND_DEMO_API_PORT ?? "19099", 10);
const repoRootPath = fileURLToPath(new URL("../..", import.meta.url));
const sandboxImage = process.env.JONASLAND_SANDBOX_IMAGE ?? "jonasland-sandbox:local";
const externalEgressProxy =
  process.env.JONASLAND_DEMO_EGRESS_PROXY ?? `http://host.docker.internal:${String(apiPort)}`;

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

const processes: ProcessConfig[] = [
  {
    slug: "egress-proxy",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/egress-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    directHttpCheck: { url: "http://127.0.0.1:19000/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "opencode",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/jonasland-sandbox/scripts/opencode-mock.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        OPENCODE_PORT: "4096",
      },
    },
    directHttpCheck: { url: "http://127.0.0.1:4096/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "agents",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/agents/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        AGENTS_SERVICE_PORT: "19061",
        OPENCODE_WRAPPER_BASE_URL: "http://127.0.0.1:19062",
      },
    },
    routeCheck: { host: "agents.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "opencode-wrapper",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/opencode-wrapper/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        OPENCODE_WRAPPER_SERVICE_PORT: "19062",
        OPENCODE_BASE_URL: "http://127.0.0.1:4096",
        OPENAI_BASE_URL: "http://api.openai.com",
        SLACK_API_BASE_URL: "http://slack.com",
        OPENAI_MODEL: "gpt-4o-mini",
        AGENTS_SERVICE_BASE_URL: "http://127.0.0.1:19061",
        DAEMON_SERVICE_BASE_URL: "http://127.0.0.1:19060",
      },
    },
    routeCheck: {
      host: "opencode-wrapper.iterate.localhost",
      path: "/healthz",
      timeoutMs: 60_000,
    },
  },
  {
    slug: "slack",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/slack/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        SLACK_SERVICE_PORT: "19063",
        AGENTS_SERVICE_BASE_URL: "http://127.0.0.1:19061",
      },
    },
    routeCheck: { host: "slack.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
];

const mockConfig: MockConfig = {
  openaiOutputText: "The answer is 42",
  openaiModel: "gpt-4o-mini",
  slackResponseOk: true,
  slackResponseTs: "123.456",
  defaultSlackPrompt: "<@BOT> what is 50 minus 8",
};

const records: EgressRecord[] = [];
const events: DemoEvent[] = [];

let deployment: ProjectDeployment | null = null;
let containerName: string | null = null;
let ingressUrl: string | null = null;
let runtimePhase: RuntimePhase = "idle";
let activeOperation: Promise<void> | null = null;
let lastError: string | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function appendEvent(message: string): void {
  const event: DemoEvent = {
    id: randomUUID(),
    createdAt: nowIso(),
    message,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  process.stdout.write(`[jonasland-demo] ${event.createdAt} ${message}\n`);
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
  records.push(entry);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
}

function runtimeState() {
  return {
    phase: runtimePhase,
    containerName,
    ingressUrl,
    image: sandboxImage,
    externalEgressProxy,
    lastError,
    busy: activeOperation !== null,
    mockConfig,
  };
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
      .exec(
        `curl -fsS -H 'Host: ${params.host}' 'http://127.0.0.1${normalizePath(params.path)}' >/dev/null`,
      )
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

  let body: string | undefined;
  if (init?.body !== undefined) {
    const raw = await new Response(init.body).text();
    body = raw;
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

async function withOperationLock(task: () => Promise<void>): Promise<void> {
  if (activeOperation !== null) {
    throw new Error("another operation is already running");
  }

  activeOperation = task();
  try {
    await activeOperation;
  } finally {
    activeOperation = null;
  }
}

async function startSandbox(): Promise<void> {
  if (deployment !== null && runtimePhase === "running") {
    appendEvent("sandbox already running; skipping start");
    return;
  }

  if (deployment !== null) {
    appendEvent("cleaning up stale sandbox before start");
    await deployment[Symbol.asyncDispose]().catch(() => {});
    deployment = null;
    containerName = null;
    ingressUrl = null;
  }

  runtimePhase = "starting";
  lastError = null;

  let sandbox: ProjectDeployment | null = null;
  let nextContainerName: string | null = null;

  try {
    appendEvent(`building image: ${sandboxImage}`);
    await execFileAsync("pnpm", ["--filter", "./jonasland/sandbox", "build"], {
      cwd: repoRootPath,
    });

    nextContainerName = `jonasland-demo-ui-${randomUUID().slice(0, 8)}`;
    appendEvent(`starting container: ${nextContainerName}`);

    sandbox = await projectDeployment({
      image: sandboxImage,
      name: nextContainerName,
      capAdd: ["NET_ADMIN", "SYS_ADMIN"],
      extraHosts: ["host.docker.internal:host-gateway"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: externalEgressProxy,
      },
    });
    const nextIngressUrl = await sandbox.ingressUrl();

    appendEvent("ensuring baseline processes");
    for (const processSlug of ["caddy", "registry", "events", "daemon"] as const) {
      await sandbox.waitForPidnapProcessRunning({ target: processSlug, timeoutMs: 120_000 });
    }

    for (const processConfig of processes) {
      await startProcess(sandbox, processConfig);
    }

    deployment = sandbox;
    containerName = nextContainerName;
    ingressUrl = nextIngressUrl;
    runtimePhase = "running";
    appendEvent(`sandbox ready at ${nextIngressUrl}`);
  } catch (error) {
    await sandbox?.[Symbol.asyncDispose]().catch(() => {});
    deployment = null;
    containerName = null;
    ingressUrl = null;
    runtimePhase = "error";
    lastError = errorMessage(error);
    appendEvent(`sandbox start failed: ${lastError.split("\n")[0] ?? "unknown error"}`);
    throw error;
  }
}

async function stopSandbox(): Promise<void> {
  if (deployment === null) {
    runtimePhase = "idle";
    containerName = null;
    ingressUrl = null;
    appendEvent("sandbox not running; nothing to stop");
    return;
  }

  runtimePhase = "stopping";
  appendEvent(`stopping container: ${containerName ?? "unknown"}`);

  await deployment[Symbol.asyncDispose]();
  deployment = null;
  containerName = null;
  ingressUrl = null;
  runtimePhase = "idle";
  appendEvent("sandbox stopped");
}

async function simulateSlackWebhook(payload: {
  text?: string;
  channel?: string;
  threadTs?: string;
}) {
  if (ingressUrl === null) {
    throw new Error("sandbox is not running");
  }

  const threadTs = payload.threadTs ?? `${Math.floor(Date.now() / 1000)}.000100`;
  const channel = payload.channel ?? "C_DEMO";
  const text = payload.text ?? mockConfig.defaultSlackPrompt;

  const response = await hostRequest(ingressUrl, "slack.iterate.localhost", "/webhook", {
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
  });

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

function isInternalPath(pathname: string): boolean {
  return (
    pathname.startsWith("/__demo") ||
    pathname === "/records" ||
    pathname === "/records/clear" ||
    pathname === "/healthz"
  );
}

function parseSafeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, phase: runtimePhase });
      return;
    }

    if (method === "GET" && url.pathname === "/records") {
      sendJson(res, 200, { total: records.length, records });
      return;
    }

    if (method === "POST" && url.pathname === "/records/clear") {
      records.length = 0;
      appendEvent("cleared egress records");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/__demo/state") {
      sendJson(res, 200, runtimeState());
      return;
    }

    if (method === "GET" && url.pathname === "/__demo/events") {
      sendJson(res, 200, { total: events.length, events });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/config") {
      const body = await readJson<Partial<MockConfig>>(req);
      if (typeof body.openaiOutputText === "string") {
        mockConfig.openaiOutputText = body.openaiOutputText;
      }
      if (typeof body.openaiModel === "string") {
        mockConfig.openaiModel = body.openaiModel;
      }
      if (typeof body.defaultSlackPrompt === "string") {
        mockConfig.defaultSlackPrompt = body.defaultSlackPrompt;
      }
      if (typeof body.slackResponseTs === "string") {
        mockConfig.slackResponseTs = body.slackResponseTs;
      }
      if (typeof body.slackResponseOk === "boolean") {
        mockConfig.slackResponseOk = body.slackResponseOk;
      }
      appendEvent("updated mock config");
      sendJson(res, 200, { ok: true, mockConfig });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/actions/start") {
      await withOperationLock(async () => {
        await startSandbox();
      });
      sendJson(res, 200, { ok: true, state: runtimeState() });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/actions/stop") {
      await withOperationLock(async () => {
        await stopSandbox();
      });
      sendJson(res, 200, { ok: true, state: runtimeState() });
      return;
    }

    if (method === "POST" && url.pathname === "/__demo/actions/simulate-slack") {
      const body = await readJson<{ text?: string; channel?: string; threadTs?: string }>(req);
      const result = await simulateSlackWebhook(body);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    const requestBody = await readBody(req);
    if (isInternalPath(url.pathname)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const startedAt = Date.now();
    let responseStatus = 599;
    let responseBody = "unmatched";
    let responseHeaders: Record<string, string | number | string[] | undefined> = {
      "content-type": "text/plain; charset=utf-8",
    };

    if (url.pathname === "/v1/responses") {
      responseStatus = 200;
      responseHeaders = { "content-type": "application/json; charset=utf-8" };
      responseBody = JSON.stringify({
        id: `resp_${randomUUID().slice(0, 8)}`,
        model: mockConfig.openaiModel,
        output_text: mockConfig.openaiOutputText,
        received: parseSafeJson(requestBody),
      });
    } else if (url.pathname === "/api/chat.postMessage") {
      responseStatus = mockConfig.slackResponseOk ? 200 : 500;
      responseHeaders = { "content-type": "application/json; charset=utf-8" };
      responseBody = JSON.stringify({
        ok: mockConfig.slackResponseOk,
        ts: mockConfig.slackResponseTs,
        received: parseSafeJson(requestBody),
      });
    }

    const record: EgressRecord = {
      id: randomUUID(),
      method,
      path: `${url.pathname}${url.search}`,
      host: req.headers.host ?? "",
      headers: toHeaders(req.headers),
      requestBody,
      responseStatus,
      responseHeaders: sanitizeResponseHeaders(responseHeaders),
      responseBody,
      createdAt: nowIso(),
      durationMs: Date.now() - startedAt,
    };
    recordEgress(record);

    setCors(res);
    res.writeHead(responseStatus, responseHeaders);
    res.end(responseBody);
  } catch (error) {
    const message = errorMessage(error);
    lastError = message;
    appendEvent(`error: ${message.split("\n")[0] ?? "unknown error"}`);
    sendJson(res, 500, { error: message });
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
});

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
