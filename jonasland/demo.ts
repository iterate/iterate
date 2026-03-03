#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  DockerDeployment,
  FlyDeployment,
  type Deployment,
  type ProviderName,
} from "@iterate-com/shared/jonasland/deployment";

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

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};
const ITERATE_REPO = process.env.ITERATE_REPO || "/home/iterate/src/github.com/iterate/iterate";
const PIDNAP_TSX_PATH = `${ITERATE_REPO}/packages/pidnap/node_modules/.bin/tsx`;
const JONASLAND_SANDBOX_DIR = `${ITERATE_REPO}/jonasland/sandbox`;

const processes: ProcessConfig[] = [
  {
    slug: "orders",
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/orders-service/src/server.ts`],
      env: {
        ...OTEL_SERVICE_ENV,
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:17320/orpc",
      },
    },
    routeCheck: { host: "orders.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "docs",
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/docs-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "docs.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "home",
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/home-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "home.iterate.localhost", path: "/", timeoutMs: 60_000 },
  },
  {
    slug: "outerbase",
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/outerbase-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "outerbase.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
  {
    slug: "egress-proxy",
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/egress-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    directHttpCheck: { url: "http://127.0.0.1:19000/healthz", timeoutMs: 60_000 },
  },
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
    slug: "clickstack",
    definition: {
      command: `${JONASLAND_SANDBOX_DIR}/clickstack-launcher.sh`,
    },
    routeCheck: { host: "clickstack.iterate.localhost", path: "/", timeoutMs: 120_000 },
  },
  {
    slug: "otel-collector",
    definition: {
      command: "/usr/local/bin/otelcol-contrib",
      args: [
        "--config",
        `${JONASLAND_SANDBOX_DIR}/otel-collector/config.yaml`,
        "--set=service.telemetry.metrics.level=None",
      ],
    },
    directHttpCheck: { url: "http://127.0.0.1:15333", timeoutMs: 60_000 },
  },
  {
    slug: "caddymanager",
    definition: {
      command: "node",
      args: [`${JONASLAND_SANDBOX_DIR}/caddymanager/server.mjs`],
    },
    routeCheck: { host: "caddymanager.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
];

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): string {
  return new Date().toISOString().slice(11, 19);
}

function logLine(message: string): void {
  process.stdout.write(`[${now()}] ${message}\n`);
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

async function waitForHostRoute(
  deployment: Deployment,
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
  deployment: Deployment,
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

async function startProcess(deployment: Deployment, config: ProcessConfig): Promise<void> {
  logLine(`starting process: ${config.slug}`);

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

  logLine(`process ready: ${config.slug}`);
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

function resolveProvider(): ProviderName {
  const provider = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
  if (provider === "docker" || provider === "fly") return provider;
  throw new Error(`Unsupported JONASLAND_E2E_PROVIDER: ${provider}`);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  if (subcommand === "e2e") {
    const forwardedArgs = process.argv[3] === "--" ? process.argv.slice(4) : process.argv.slice(3);
    execFileSync("pnpm", ["--filter", "@iterate-com/jonasland-e2e", "e2e", ...forwardedArgs], {
      stdio: "inherit",
    });
    return;
  }

  if (subcommand !== undefined && subcommand !== "demo") {
    throw new Error(`unknown jonasland command: ${subcommand}`);
  }

  const dockerImage = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
  const flyImage = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";
  const containerName = `jonasland-demo-${randomUUID().slice(0, 8)}`;

  const provider = resolveProvider();
  if (provider === "docker") {
    logLine(`building docker image: ${dockerImage}`);
    execFileSync("pnpm", ["--filter", "./jonasland/sandbox", "build"], { stdio: "inherit" });
  } else if (flyImage.trim().length === 0) {
    throw new Error("Set JONASLAND_E2E_FLY_IMAGE for fly deployments");
  }

  logLine(`starting deployment: ${containerName} (provider=${provider})`);
  const deployment =
    provider === "fly"
      ? await FlyDeployment.createWithConfig({
          flyImage,
          name: containerName,
        }).create()
      : await DockerDeployment.createWithConfig({
          dockerImage,
          name: containerName,
          capAdd: ["NET_ADMIN", "SYS_ADMIN"],
          extraHosts: ["host.docker.internal:host-gateway"],
        }).create();

  logLine("ensuring baseline processes");
  for (const processSlug of ["caddy", "registry", "events"] as const) {
    await deployment.waitForPidnapProcessRunning({ target: processSlug, timeoutMs: 120_000 });
  }

  for (const config of processes) {
    await startProcess(deployment, config);
  }

  const ingressUrl = await deployment.ingressUrl();
  const ingressPort = Number(new URL(ingressUrl).port || "80");

  logLine("running sample API calls");
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
  const traceIdMatches = [...streamText.matchAll(/"traceId"\s*:\s*"([0-9a-f]{32})"/gi)].map(
    (match) => match[1],
  );
  const traceId = traceIdMatches.at(-1);

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

  process.stdout.write("\n");
  process.stdout.write("jonasland demo is up\n");
  process.stdout.write(`container: ${containerName}\n`);
  process.stdout.write(
    provider === "fly" ? `flyImage: ${flyImage}\n` : `dockerImage: ${dockerImage}\n`,
  );
  process.stdout.write(`ingress: ${ingressUrl}\n`);
  process.stdout.write("\n");
  process.stdout.write("URLs to visit\n");
  process.stdout.write(`- home: ${toHostUrl("home.iterate.localhost", ingressPort, "/")}\n`);
  process.stdout.write(`- docs: ${toHostUrl("docs.iterate.localhost", ingressPort, "/")}\n`);
  process.stdout.write(`- orders: ${toHostUrl("orders.iterate.localhost", ingressPort, "/")}\n`);
  process.stdout.write(`- events: ${toHostUrl("events.iterate.localhost", ingressPort, "/")}\n`);
  process.stdout.write(
    `- outerbase: ${toHostUrl("outerbase.iterate.localhost", ingressPort, "/")}\n`,
  );
  process.stdout.write(
    `- registry: ${toHostUrl("registry.iterate.localhost", ingressPort, "/")}\n`,
  );
  process.stdout.write(`- pidnap: ${toHostUrl("pidnap.iterate.localhost", ingressPort, "/")}\n`);
  process.stdout.write(
    `- openobserve: ${toHostUrl("openobserve.iterate.localhost", ingressPort, "/")}\n`,
  );
  process.stdout.write("  login: root@example.com / Complexpass#123\n");
  process.stdout.write(
    `- clickstack: ${toHostUrl("clickstack.iterate.localhost", ingressPort, "/")}\n`,
  );
  process.stdout.write(
    `- caddymanager: ${toHostUrl("caddymanager.iterate.localhost", ingressPort, "/")}\n`,
  );
  process.stdout.write("\n");

  process.stdout.write("sample API calls\n");
  process.stdout.write(
    `- placed order: ${JSON.stringify({ id: placedOrder.id, sku: placedOrder.sku, eventId: placedOrder.eventId })}\n`,
  );
  process.stdout.write(
    `- fetched order: ${JSON.stringify({ id: foundOrder.id, quantity: foundOrder.quantity, status: foundOrder.status })}\n`,
  );
  process.stdout.write(
    `- stream count: ${String(streamList.json.length)} (includes /orders stream: ${String(streamList.json.some((entry) => entry.path === "/orders"))})\n`,
  );
  process.stdout.write(
    `- home OTEL endpoint: ${homeObservability.otel?.tracesEndpoint ?? "n/a"}\n`,
  );
  process.stdout.write(`- registry route count: ${String(registryRouteCount.total)}\n`);
  process.stdout.write("\n");

  process.stdout.write("trace links\n");
  if (traceId) {
    process.stdout.write(`- trace id: ${traceId}\n`);
    process.stdout.write(
      `- clickstack trace query: ${toHostUrl("clickstack.iterate.localhost", ingressPort, `/?q=${encodeURIComponent(traceId)}`)}\n`,
    );
    process.stdout.write(
      `- clickstack alt query: ${toHostUrl("clickstack.iterate.localhost", ingressPort, `/search?query=${encodeURIComponent(traceId)}`)}\n`,
    );
  } else {
    process.stdout.write("- no traceId parsed from /api/streams/orders yet\n");
    process.stdout.write(
      `- open clickstack and search for order event id: ${placedOrder.eventId}\n`,
    );
  }
  process.stdout.write("\n");

  process.stdout.write("stuff to try\n");
  process.stdout.write(
    `- create another order:\n  curl -sS -H 'Host: orders.iterate.localhost' -H 'content-type: application/json' --data '{"sku":"demo-2","quantity":3}' ${ingressUrl}/api/orders\n`,
  );
  process.stdout.write(
    `- inspect events stream:\n  curl -sS -H 'Host: events.iterate.localhost' ${ingressUrl}/api/streams/orders\n`,
  );
  process.stdout.write(
    `- inspect pidnap processes:\n  curl -sS -H 'Host: pidnap.iterate.localhost' -H 'content-type: application/json' --data '{}' ${ingressUrl}/rpc/processes/list\n`,
  );
  process.stdout.write(
    `- inspect registry routes:\n  curl -sS -H 'Host: registry.iterate.localhost' ${ingressUrl}/api/routes\n`,
  );
  process.stdout.write("\n");

  process.stdout.write("cleanup\n");
  process.stdout.write(`- stop container: docker rm -f ${containerName}\n`);
  process.stdout.write(`- tail logs: docker logs -f ${containerName}\n`);
  process.stdout.write("\n");
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
