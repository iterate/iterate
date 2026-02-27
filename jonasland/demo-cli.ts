#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import * as prompts from "@clack/prompts";
import { os } from "@orpc/server";
import { createCli } from "trpc-cli";
import { projectDeployment, type ProjectDeployment } from "./e2e/test-helpers/index.ts";
import { ON_DEMAND_OTEL_SERVICE_ENV, ON_DEMAND_PROCESSES } from "./shared/on-demand-processes.ts";

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

type ClickstackSource = {
  id: string;
  kind: string;
  traceSourceId?: string;
};

type ClickstackTraceRow = {
  TimestampIso: string;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  ServiceName: string;
  StatusCode: string;
  Duration: string | number;
  SpanName: string;
};

type ClickstackTraceLink = {
  url: string;
  rowWhere?: string;
  rowSource?: string;
  eventRowWhere?: string;
};

type StreamTraceContext = {
  traceId?: string;
  spanId?: string;
  createdAt?: string;
};

const OTEL_SERVICE_ENV = ON_DEMAND_OTEL_SERVICE_ENV;

const onDemandProcesses: ProcessConfig[] = ON_DEMAND_PROCESSES.map((processConfig) => ({
  slug: processConfig.slug,
  definition: processConfig.definition,
  ...(processConfig.routeCheck
    ? { routeCheck: { ...processConfig.routeCheck, timeoutMs: processConfig.routeCheck.timeoutMs ?? 60_000 } }
    : {}),
  ...(processConfig.directHttpCheck
    ? { directHttpCheck: { ...processConfig.directHttpCheck, timeoutMs: processConfig.directHttpCheck.timeoutMs ?? 60_000 } }
    : {}),
}));

const processes: ProcessConfig[] = [
  {
    slug: "orders",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/orders-service/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010/orpc",
      },
    },
    routeCheck: { host: "orders.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "docs",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/docs-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "docs.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "home",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/home-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "home.iterate.localhost", path: "/", timeoutMs: 60_000 },
  },
  ...onDemandProcesses,
  {
    slug: "openobserve",
    definition: {
      command: "/usr/local/bin/openobserve",
      env: {
        ZO_ROOT_USER_EMAIL: "root@example.com",
        ZO_ROOT_USER_PASSWORD: "Complexpass#123",
        ZO_LOCAL_MODE: "true",
        ZO_DATA_DIR: "/var/lib/openobserve",
      },
    },
    routeCheck: { host: "openobserve.iterate.localhost", path: "/", timeoutMs: 120_000 },
  },
  {
    slug: "otel-collector",
    definition: {
      command: "/usr/local/bin/otelcol-contrib",
      args: [
        "--config",
        "/opt/jonasland-sandbox/otel-collector/config.yaml",
        "--set=service.telemetry.metrics.level=None",
      ],
    },
    directHttpCheck: { url: "http://127.0.0.1:15333", timeoutMs: 60_000 },
  },
  {
    slug: "caddymanager",
    definition: {
      command: "node",
      args: ["/opt/jonasland-sandbox/caddymanager/server.mjs"],
    },
    routeCheck: { host: "caddymanager.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
];

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePath(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function toHostUrl(host: string, port: number, pathname = "/"): string {
  return `http://${host}:${String(port)}${normalizePath(pathname)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function writeLine(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function padKeyValueRows(rows: Array<[string, string]>): string[] {
  const maxWidth = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(maxWidth)}  ${value}`);
}

function printSectionNote(title: string, lines: string[]): void {
  const contentWidth = Math.max(title.length + 2, ...lines.map((line) => line.length), 24);

  const horizontal = "─".repeat(contentWidth + 2);
  writeLine(`┌${horizontal}┐`);
  writeLine(`│ ${title.padEnd(contentWidth)} │`);
  writeLine(`├${horizontal}┤`);
  if (lines.length === 0) {
    writeLine(`│ ${"".padEnd(contentWidth)} │`);
  } else {
    for (const line of lines) {
      writeLine(`│ ${line.padEnd(contentWidth)} │`);
    }
  }
  writeLine(`└${horizontal}┘`);
  writeLine();
}

function escapeSqlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "''");
}

function nsToSecondsString(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fraction = value % 1_000_000_000n;
  const fractionPart = fraction.toString().padStart(9, "0");
  return `${whole.toString()}.${fractionPart}`.replace(/\.?0+$/, "") || "0";
}

function toRowWhere(row: ClickstackTraceRow): string {
  const timestampExpr = `parseDateTime64BestEffort('${escapeSqlString(row.TimestampIso)}', +9)`;
  const durationNs = BigInt(String(row.Duration));
  const roundedMs = (durationNs + 500_000n) / 1_000_000n;
  const status = row.StatusCode || "Unset";

  return [
    `Timestamp=${timestampExpr}`,
    `ServiceName='${escapeSqlString(row.ServiceName)}'`,
    `StatusCode='${escapeSqlString(status)}'`,
    `round(divide(Duration, +1000000.))=${roundedMs.toString()}`,
    `SpanName='${escapeSqlString(row.SpanName)}'`,
  ].join(" AND ");
}

function toEventRowWhere(row: ClickstackTraceRow): string {
  const timestampExpr = `parseDateTime64BestEffort('${escapeSqlString(row.TimestampIso)}', +9)`;
  const durationNs = BigInt(String(row.Duration));
  const status = row.StatusCode || "Unset";

  return [
    `SpanName='${escapeSqlString(row.SpanName)}'`,
    `Timestamp=${timestampExpr}`,
    `SpanId='${escapeSqlString(row.SpanId)}'`,
    `ServiceName='${escapeSqlString(row.ServiceName)}'`,
    `(Duration)/1e9=${nsToSecondsString(durationNs)}`,
    `ParentSpanId='${escapeSqlString(row.ParentSpanId ?? "")}'`,
    `StatusCode='${escapeSqlString(status)}'`,
  ].join(" AND ");
}

async function fetchClickstackTraceRow(
  deployment: ProjectDeployment,
  context: StreamTraceContext,
): Promise<ClickstackTraceRow | undefined> {
  async function runSingleRowQuery(query: string): Promise<ClickstackTraceRow | undefined> {
    const result = await deployment
      .exec(["curl", "-sS", "http://127.0.0.1:8123/", "--data-binary", query])
      .catch(() => ({ exitCode: 1, output: "" }));

    if (result.exitCode !== 0) return undefined;
    const firstLine = result.output.trim().split("\n")[0];
    if (!firstLine || firstLine.startsWith("Code:")) return undefined;

    try {
      return JSON.parse(firstLine) as ClickstackTraceRow;
    } catch {
      return undefined;
    }
  }

  const baseSelect = [
    "SELECT",
    "concat(replaceOne(toString(Timestamp), ' ', 'T'), 'Z') AS TimestampIso,",
    "TraceId,",
    "SpanId,",
    "ParentSpanId,",
    "ServiceName,",
    "StatusCode,",
    "Duration,",
    "SpanName",
    "FROM default.otel_traces",
  ];

  const queries: string[] = [];
  if (context.traceId) {
    queries.push(
      [
        ...baseSelect,
        `WHERE TraceId = '${escapeSqlString(context.traceId)}'`,
        "ORDER BY Timestamp DESC",
        "LIMIT 1",
        "FORMAT JSONEachRow",
      ].join(" "),
    );
  }

  if (context.spanId) {
    queries.push(
      [
        ...baseSelect,
        `WHERE SpanId = '${escapeSqlString(context.spanId)}'`,
        "ORDER BY Timestamp DESC",
        "LIMIT 1",
        "FORMAT JSONEachRow",
      ].join(" "),
    );
  }

  if (context.createdAt) {
    const timestampExpr = `parseDateTime64BestEffort('${escapeSqlString(context.createdAt)}', 9)`;
    queries.push(
      [
        ...baseSelect,
        `WHERE Timestamp BETWEEN ${timestampExpr} - INTERVAL 30 SECOND AND ${timestampExpr} + INTERVAL 30 SECOND`,
        "ORDER BY",
        "(SpanName = 'caddy-events-http') DESC,",
        `abs(toUnixTimestamp64Nano(Timestamp) - toUnixTimestamp64Nano(${timestampExpr})) ASC`,
        "LIMIT 1",
        "FORMAT JSONEachRow",
      ].join(" "),
    );
  }

  queries.push(
    [
      ...baseSelect,
      "ORDER BY (SpanName = 'caddy-events-http') DESC, Timestamp DESC",
      "LIMIT 1",
      "FORMAT JSONEachRow",
    ].join(" "),
  );

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const query of queries) {
      const row = await runSingleRowQuery(query);
      if (row) return row;
    }
    await sleep(500);
  }

  return undefined;
}

async function buildClickstackTraceLink(params: {
  deployment: ProjectDeployment;
  ingressUrl: string;
  ingressPort: number;
  traceId: string;
  spanId?: string;
  createdAt?: string;
}): Promise<ClickstackTraceLink> {
  const clickstackUrl = new URL(
    toHostUrl("clickstack.iterate.localhost", params.ingressPort, "/search"),
  );
  const sources = await hostJson<ClickstackSource[]>(
    params.ingressUrl,
    "clickstack.iterate.localhost",
    "/api/sources",
  ).catch(() => [] as ClickstackSource[]);

  const traceSource =
    sources.find((entry) => entry.kind === "trace") ??
    sources.find((entry) => entry.traceSourceId !== undefined);
  const sourceId = traceSource?.id ?? "";

  const queryParams = clickstackUrl.searchParams;
  queryParams.set("query", params.traceId);
  queryParams.set("source", sourceId);
  queryParams.set("where", "");
  queryParams.set("select", "");
  queryParams.set("whereLanguage", "lucene");
  queryParams.set("filters", "[]");
  queryParams.set("orderBy", "Timestamp DESC");
  queryParams.set("isLive", "false");

  const row = await fetchClickstackTraceRow(params.deployment, {
    traceId: params.traceId,
    spanId: params.spanId,
    createdAt: params.createdAt,
  });
  const rowTimestampMs = row ? Date.parse(row.TimestampIso) : Date.now();
  const halfWindowMs = 7.5 * 60 * 1000;
  queryParams.set("from", String(Math.max(0, Math.floor(rowTimestampMs - halfWindowMs))));
  queryParams.set("to", String(Math.floor(rowTimestampMs + halfWindowMs)));

  if (row && sourceId) {
    const rowWhere = toRowWhere(row);
    const eventRowWhere = toEventRowWhere(row);
    queryParams.set("rowWhere", rowWhere);
    queryParams.set("rowSource", sourceId);
    queryParams.set(
      "eventRowWhere",
      JSON.stringify({
        id: eventRowWhere,
        type: "trace",
        aliasWith: [],
      }),
    );
    return {
      url: clickstackUrl.toString(),
      rowWhere,
      rowSource: sourceId,
      eventRowWhere,
    };
  }

  return { url: clickstackUrl.toString() };
}

function parseStreamTraceContext(streamText: string): StreamTraceContext {
  const contexts: StreamTraceContext[] = [];
  for (const line of streamText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const jsonText = trimmed.slice("data:".length).trim();
    if (!jsonText) continue;

    try {
      const payload = JSON.parse(jsonText) as {
        createdAt?: string;
        trace?: { traceId?: string; spanId?: string };
      };
      if (payload.trace?.traceId) {
        contexts.push({
          traceId: payload.trace.traceId,
          spanId: payload.trace.spanId,
          createdAt: payload.createdAt,
        });
      }
    } catch {
      continue;
    }
  }

  const latest = contexts.at(-1);
  if (latest) return latest;

  const fallbackTraceId = [...streamText.matchAll(/"traceId"\s*:\s*"([0-9a-f]{32})"/gi)]
    .map((match) => match[1])
    .at(-1);
  return { traceId: fallbackTraceId };
}

async function waitForHostRoute(
  deployment: ProjectDeployment,
  params: { host: string; path: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await deployment
      .exec(
        `curl -fsS -H 'Host: ${params.host}' 'http://127.0.0.1${normalizePath(params.path)}' >/dev/null`,
      )
      .catch(() => ({ exitCode: 1, output: "" }));

    if (result.exitCode === 0) return;
    await sleep(200);
  }

  throw new Error(`timed out waiting for route ${params.host}${normalizePath(params.path)}`);
}

async function waitForDirectHttp(
  deployment: ProjectDeployment,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await deployment
      .exec(["curl", "-fsS", params.url])
      .catch(() => ({ exitCode: 1, output: "" }));

    if (result.exitCode === 0) return;
    await sleep(200);
  }

  throw new Error(`timed out waiting for direct http ${params.url}`);
}

async function startProcess(deployment: ProjectDeployment, config: ProcessConfig): Promise<void> {
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: config.slug,
    definition: config.definition,
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });

  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: config.slug });
  }

  await deployment.waitForPidnapProcessRunning({
    target: config.slug,
    timeoutMs: 120_000,
  });

  if (config.routeCheck) {
    await waitForHostRoute(deployment, config.routeCheck);
  }

  if (config.directHttpCheck) {
    await waitForDirectHttp(deployment, config.directHttpCheck);
  }
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
  ingressUrl: string,
  host: string,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(normalizePath(pathname), ingressUrl);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  headers.set("host", host);
  const body = await bodyInitToString(init?.body);

  if (body !== undefined) {
    headers.set("content-length", Buffer.byteLength(body, "utf-8").toString());
  } else {
    headers.delete("content-length");
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

async function hostJson<T>(
  ingressUrl: string,
  host: string,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await hostRequest(ingressUrl, host, pathname, init);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `request failed ${host}${normalizePath(pathname)} (${response.status}): ${text}`,
    );
  }

  return JSON.parse(text) as T;
}

async function runSandboxDemo(): Promise<void> {
  const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
  const demoEgressProxy =
    process.env.JONASLAND_DEMO_EGRESS_PROXY || "http://host.docker.internal:19099";
  const demoUiUrl = process.env.JONASLAND_DEMO_UI_URL || "http://127.0.0.1:5173";
  const containerName = `jonasland-demo-${randomUUID().slice(0, 8)}`;

  prompts.intro("Jonasland Demo");
  const spinner = prompts.spinner();

  spinner.start(`building image: ${image}`);
  execFileSync("pnpm", ["--filter", "./jonasland/sandbox", "build"], { stdio: "inherit" });
  spinner.stop(`built image: ${image}`);

  spinner.start(`starting container: ${containerName}`);
  const deployment = await projectDeployment({
    image,
    name: containerName,
    capAdd: ["NET_ADMIN", "SYS_ADMIN"],
    extraHosts: ["host.docker.internal:host-gateway"],
    env: {
      ITERATE_EXTERNAL_EGRESS_PROXY: demoEgressProxy,
    },
  });
  spinner.stop(`container started: ${containerName}`);

  spinner.start("waiting for baseline services");
  for (const processSlug of ["caddy", "registry", "events", "daemon"] as const) {
    await deployment.waitForPidnapProcessRunning({ target: processSlug, timeoutMs: 120_000 });
  }
  spinner.stop("baseline services ready");

  spinner.start("starting demo services");
  for (const config of processes) {
    spinner.message(`starting process: ${config.slug}`);
    await startProcess(deployment, config);
    spinner.message(`process ready: ${config.slug}`);
  }
  spinner.stop("demo services ready");

  const ingressUrl = await deployment.ingressUrl();
  const ingressPort = Number(new URL(ingressUrl).port || "80");

  spinner.start("running sample API calls");
  const placedOrder = await hostJson<{
    id: string;
    sku: string;
    quantity: number;
    status: string;
    eventId: string;
  }>(ingressUrl, "orders.iterate.localhost", "/api/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sku: `demo-sku-${randomUUID().slice(0, 6)}`,
      quantity: 2,
    }),
  });

  const foundOrder = await hostJson<{
    id: string;
    eventId: string;
    sku: string;
    quantity: number;
    status: string;
  }>(ingressUrl, "orders.iterate.localhost", `/api/orders/${placedOrder.id}`);

  const streamList = await hostJson<{
    json: Array<{ path: string; eventCount: number; lastEventCreatedAt: string }>;
  }>(ingressUrl, "events.iterate.localhost", "/orpc/listStreams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: {} }),
  });

  const streamResponse = await hostRequest(
    ingressUrl,
    "events.iterate.localhost",
    "/api/streams/orders",
  );
  const streamText = await streamResponse.text();
  const streamTrace = parseStreamTraceContext(streamText);
  const traceId = streamTrace.traceId;
  const clickstackTraceLink = traceId
    ? await buildClickstackTraceLink({
        deployment,
        ingressUrl,
        ingressPort,
        traceId,
        spanId: streamTrace.spanId,
        createdAt: streamTrace.createdAt,
      }).catch(() => undefined)
    : undefined;

  let slackDemoResult: { ok?: boolean; status?: number; body?: string; error?: string } = {};
  try {
    const slackResponse = await hostRequest(ingressUrl, "slack.iterate.localhost", "/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event: {
          type: "app_mention",
          user: "U_DEMO",
          text: "<@BOT> what is 50 minus 8",
          channel: "C_DEMO",
          ts: "1730000000.000100",
          thread_ts: "1730000000.000100",
        },
      }),
    });
    slackDemoResult = {
      ok: slackResponse.ok,
      status: slackResponse.status,
      body: await slackResponse.text(),
    };
  } catch (error) {
    slackDemoResult = { error: errorMessage(error) };
  }

  const homeObservability = await hostJson<{
    otel?: {
      tracesEndpoint?: string | null;
      logsEndpoint?: string | null;
      baseEndpoint?: string | null;
    };
  }>(ingressUrl, "home.iterate.localhost", "/api/observability");

  const registryRouteCount = await hostJson<{ total: number }>(
    ingressUrl,
    "registry.iterate.localhost",
    "/api/routes",
  );

  const traceLinkFile = `/tmp/${containerName}-trace-link.txt`;
  if (clickstackTraceLink?.url) {
    writeFileSync(traceLinkFile, `${clickstackTraceLink.url}\n`);
  }

  spinner.stop("sample calls complete");

  printSectionNote(
    "Start Here",
    padKeyValueRows([
      ["demo UI", `${demoUiUrl} (run: pnpm jonasland:demo-ui)`],
      ["sandbox demo app", toHostUrl("home.iterate.localhost", ingressPort, "/")],
    ]),
  );

  printSectionNote(
    "Jonasland Demo",
    padKeyValueRows([
      ["container", containerName],
      ["image", image],
      ["ingress", ingressUrl],
    ]),
  );

  printSectionNote(
    "URLs",
    padKeyValueRows([
      ["demo app", toHostUrl("home.iterate.localhost", ingressPort, "/")],
      ["demo control UI", `${demoUiUrl} (run: pnpm jonasland:demo-ui)`],
      ["home", toHostUrl("home.iterate.localhost", ingressPort, "/")],
      ["docs", toHostUrl("docs.iterate.localhost", ingressPort, "/")],
      ["orders", toHostUrl("orders.iterate.localhost", ingressPort, "/")],
      ["events", toHostUrl("events.iterate.localhost", ingressPort, "/")],
      ["daemon", toHostUrl("daemon.iterate.localhost", ingressPort, "/healthz")],
      ["agents", toHostUrl("agents.iterate.localhost", ingressPort, "/healthz")],
      [
        "opencode-wrapper",
        toHostUrl("opencode-wrapper.iterate.localhost", ingressPort, "/healthz"),
      ],
      ["slack", toHostUrl("slack.iterate.localhost", ingressPort, "/healthz")],
      ["opencode", toHostUrl("opencode.iterate.localhost", ingressPort, "/healthz")],
      ["outerbase", toHostUrl("outerbase.iterate.localhost", ingressPort, "/")],
      ["registry", toHostUrl("registry.iterate.localhost", ingressPort, "/")],
      ["pidnap", toHostUrl("pidnap.iterate.localhost", ingressPort, "/")],
      ["openobserve", toHostUrl("openobserve.iterate.localhost", ingressPort, "/")],
      ["openobserve login", "root@example.com / Complexpass#123"],
      ["clickstack", toHostUrl("clickstack.iterate.localhost", ingressPort, "/")],
      ["caddymanager", toHostUrl("caddymanager.iterate.localhost", ingressPort, "/")],
    ]),
  );

  printSectionNote(
    "Sample API Calls",
    padKeyValueRows([
      [
        "placed order",
        JSON.stringify({ id: placedOrder.id, sku: placedOrder.sku, eventId: placedOrder.eventId }),
      ],
      [
        "fetched order",
        JSON.stringify({
          id: foundOrder.id,
          quantity: foundOrder.quantity,
          status: foundOrder.status,
        }),
      ],
      [
        "stream count",
        `${String(streamList.json.length)} (includes /orders: ${String(streamList.json.some((entry) => entry.path === "/orders"))})`,
      ],
      ["home OTEL endpoint", homeObservability.otel?.tracesEndpoint ?? "n/a"],
      ["registry route count", String(registryRouteCount.total)],
      ["demo egress proxy", demoEgressProxy],
      ["slack webhook smoke", JSON.stringify(slackDemoResult)],
    ]),
  );

  const traceLines: string[] = [];
  if (traceId) {
    traceLines.push(...padKeyValueRows([["trace id", traceId]]));
    if (clickstackTraceLink?.url) {
      traceLines.push(...padKeyValueRows([["trace link file", traceLinkFile]]));
      traceLines.push("open the file to copy full clickstack deep-link");
    } else {
      traceLines.push(
        ...padKeyValueRows([
          [
            "clickstack search",
            toHostUrl(
              "clickstack.iterate.localhost",
              ingressPort,
              `/search?query=${encodeURIComponent(traceId)}`,
            ),
          ],
        ]),
      );
    }
  } else {
    traceLines.push(
      ...padKeyValueRows([["trace", "no traceId parsed from /api/streams/orders yet"]]),
    );
    traceLines.push(
      ...padKeyValueRows([["clickstack search hint", `order event id: ${placedOrder.eventId}`]]),
    );
  }
  printSectionNote("Trace Links", traceLines);

  printSectionNote("Stuff To Try", [
    "start local mock egress (separate terminal)",
    "  pnpm tsx jonasland/mock-egress-proxy-demo.ts",
    "",
    "send slack webhook",
    `  curl -sS -H 'Host: slack.iterate.localhost' -H 'content-type: application/json' --data '{"event":{"type":"app_mention","user":"U1","text":"<@BOT> what is 50 minus 8","channel":"C1","ts":"1730000000.000100","thread_ts":"1730000000.000100"}}' ${ingressUrl}/webhook`,
    "",
    "create another order",
    `  curl -sS -H 'Host: orders.iterate.localhost' -H 'content-type: application/json' --data '{"sku":"demo-2","quantity":3}' ${ingressUrl}/api/orders`,
    "",
    "inspect events stream",
    `  curl -sS -H 'Host: events.iterate.localhost' ${ingressUrl}/api/streams/orders`,
    "",
    "inspect pidnap processes",
    `  curl -sS -H 'Host: pidnap.iterate.localhost' -H 'content-type: application/json' --data '{}' ${ingressUrl}/rpc/processes/list`,
    "",
    "inspect registry routes",
    `  curl -sS -H 'Host: registry.iterate.localhost' ${ingressUrl}/api/routes`,
    "",
    "inspect mock egress records",
    "  curl -sS http://127.0.0.1:19099/records | jq",
  ]);

  printSectionNote(
    "Cleanup",
    padKeyValueRows([
      ["stop container", `docker rm -f ${containerName}`],
      ["tail logs", `docker logs -f ${containerName}`],
    ]),
  );

  writeLine("Jonasland demo is ready.");
}

async function runDemoUi(): Promise<void> {
  const demoUiUrl = process.env.JONASLAND_DEMO_UI_URL || "http://127.0.0.1:5173";
  prompts.intro("Jonasland Demo UI");

  const providerChoice = await prompts.select({
    message: "Choose sandbox provider",
    options: [
      {
        value: "docker",
        label: "Docker (works now)",
        hint: "start local container sandbox",
      },
      {
        value: "fly",
        label: "Fly.io (not implemented)",
        hint: "placeholder for remote provider",
      },
    ],
    initialValue: "docker",
  });

  if (prompts.isCancel(providerChoice)) {
    prompts.cancel("Cancelled.");
    return;
  }

  const provider = providerChoice as "docker" | "fly";
  if (provider === "fly") {
    prompts.log.warning("Fly provider is not implemented yet.");
    return;
  }

  prompts.log.info(`Provider: ${provider}`);
  prompts.log.info(`Open ${demoUiUrl}`);
  prompts.log.info("Starting demo UI + API (Ctrl+C to stop)");

  execFileSync("pnpm", ["--filter", "@iterate-com/jonasland-demo", "dev"], {
    stdio: "inherit",
    env: {
      ...process.env,
      JONASLAND_DEMO_PROVIDER: provider,
    },
  });
}

const cliRouter = os.router({
  demo: os.meta({ description: "Start Jonasland demo UI (default)." }).handler(async () => {
    await runDemoUi();
  }),
  sandbox: os
    .meta({ description: "Start sandbox directly and print local links (verbose)." })
    .handler(async () => {
      await runSandboxDemo();
    }),
});

async function runCli(): Promise<void> {
  if (process.argv.length <= 2) {
    process.argv.push("demo");
  }

  const cli = createCli({
    name: "jonasland",
    version: "0.0.1",
    description: "Jonasland demo helper",
    router: cliRouter,
  });

  await cli.run();
}

runCli().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
