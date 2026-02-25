import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "../../../spec/test-helpers.ts";
import {
  type SandboxFixture,
  projectDeployment as createProjectDeployment,
} from "../test-helpers/index.ts";

const sandboxImage = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";

export { test };

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

type OnDemandProcessName = "orders" | "outerbase" | "docs" | "openobserve" | "caddymanager";
type OnDemandProcessConfig = {
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  routeCheck: {
    host: string;
    path: string;
    timeoutMs?: number;
    readyStatus?: "ok" | "lt400";
  };
  startupTimeoutMs?: number;
};

const ON_DEMAND_PROCESSES: Record<OnDemandProcessName, OnDemandProcessConfig> = {
  orders: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/orders-service/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010/orpc",
      },
    },
    routeCheck: { host: "orders.iterate.localhost", path: "/healthz" },
  },
  outerbase: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/outerbase-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "outerbase.iterate.localhost", path: "/healthz" },
  },
  docs: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/docs-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "docs.iterate.localhost", path: "/healthz" },
  },
  openobserve: {
    definition: {
      command: "/usr/local/bin/openobserve",
      args: [],
      env: {
        ZO_ROOT_USER_EMAIL: "root@example.com",
        ZO_ROOT_USER_PASSWORD: "Complexpass#123",
        ZO_LOCAL_MODE: "true",
        ZO_DATA_DIR: "/var/lib/openobserve",
      },
    },
    startupTimeoutMs: 120_000,
    routeCheck: {
      host: "openobserve.iterate.localhost",
      path: "/",
      timeoutMs: 120_000,
      readyStatus: "lt400",
    },
  },
  caddymanager: {
    definition: {
      command: "node",
      args: ["/opt/jonasland-sandbox/caddymanager/server.mjs"],
      env: {},
    },
    routeCheck: { host: "caddymanager.iterate.localhost", path: "/healthz", timeoutMs: 60_000 },
  },
};

export type HostRequestParams = {
  host: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
};

function withBody(params: HostRequestParams): { body: string | undefined; headers: Headers } {
  const headers = new Headers(params.headers);
  const body = params.json === undefined ? params.body : JSON.stringify(params.json);

  if (params.json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (body !== undefined) {
    headers.set("content-length", Buffer.byteLength(body, "utf-8").toString());
  }

  return { body, headers };
}

export async function ingressRequest(
  deployment: Pick<SandboxFixture, "ingressUrl">,
  params: HostRequestParams,
): Promise<Response> {
  const ingressBaseUrl = await deployment.ingressUrl();
  const targetUrl = new URL(params.path, ingressBaseUrl);
  const method = (
    params.method ?? (params.json === undefined && params.body === undefined ? "GET" : "POST")
  ).toUpperCase();
  const { body, headers } = withBody(params);

  headers.set("host", params.host);

  return await new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      targetUrl,
      {
        method,
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
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
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        });
      },
    );

    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

export async function waitForHostRoute(
  deployment: Pick<SandboxFixture, "ingressUrl">,
  params: { host: string; path: string; timeoutMs?: number; readyStatus?: "ok" | "lt400" },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const readyStatus = params.readyStatus ?? "ok";

  while (Date.now() < deadline) {
    const response = await ingressRequest(deployment, {
      host: params.host,
      path: params.path,
    }).catch(() => undefined);

    if (
      response &&
      ((readyStatus === "ok" && response.ok) || (readyStatus === "lt400" && response.status < 400))
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`timed out waiting for host route ${params.host}${params.path}`);
}

export async function waitForDocsSources(
  deployment: Pick<SandboxFixture, "ingressUrl">,
  expectedHosts: string[],
): Promise<{ sources: Array<{ id: string; title: string; specUrl: string }>; total: number }> {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    const response = await ingressRequest(deployment, {
      host: "docs.iterate.localhost",
      path: "/api/openapi-sources",
    }).catch(() => undefined);

    if (response?.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | {
            sources: Array<{ id: string; title: string; specUrl: string }>;
            total: number;
          }
        | undefined;

      if (payload) {
        const ids = new Set(payload.sources.map((source) => source.id));
        const allPresent = expectedHosts.every((expectedHost) => ids.has(expectedHost));
        if (allPresent) {
          return payload;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`timed out waiting for docs sources: ${expectedHosts.join(", ")}`);
}

export async function startOnDemandProcess(
  deployment: Pick<SandboxFixture, "pidnap" | "waitForPidnapProcessRunning" | "ingressUrl">,
  processName: OnDemandProcessName,
): Promise<void> {
  const processConfig = ON_DEMAND_PROCESSES[processName];

  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: processName,
    definition: processConfig.definition,
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });

  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: processName });
  }

  await deployment.waitForPidnapProcessRunning({
    target: processName,
    timeoutMs: processConfig.startupTimeoutMs ?? 45_000,
  });

  await waitForHostRoute(deployment, {
    ...processConfig.routeCheck,
    timeoutMs: processConfig.routeCheck.timeoutMs ?? processConfig.startupTimeoutMs ?? 45_000,
  });
}

export async function projectDeployment(params?: { name?: string }): Promise<SandboxFixture> {
  return await createProjectDeployment({
    image: sandboxImage,
    name: params?.name ?? `jonasland-playwright-${randomUUID()}`,
  });
}
