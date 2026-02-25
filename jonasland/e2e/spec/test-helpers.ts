import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "../../../spec/test-helpers.ts";
import {
  type SandboxFixture,
  projectDeployment as createProjectDeployment,
} from "../test-helpers/index.ts";
import {
  sharedOnDemandProcesses,
  startOnDemandProcess as startOnDemandProcessShared,
  type OnDemandProcessConfig,
  waitForDocsSources as waitForDocsSourcesShared,
  type DocsSourcesPayload,
} from "../test-helpers/on-demand-processes.ts";

const sandboxImage = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";

export { test };

const ON_DEMAND_PROCESSES: Record<string, OnDemandProcessConfig> = {
  ...sharedOnDemandProcesses,
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
type OnDemandProcessName = keyof typeof ON_DEMAND_PROCESSES;

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
): Promise<DocsSourcesPayload> {
  return await waitForDocsSourcesShared({
    expectedHosts,
    fetchSources: async () => {
      const response = await ingressRequest(deployment, {
        host: "docs.iterate.localhost",
        path: "/api/openapi-sources",
      }).catch(() => undefined);
      if (!response?.ok) return undefined;
      return (await response.json().catch(() => undefined)) as DocsSourcesPayload | undefined;
    },
  });
}

export async function startOnDemandProcess(
  deployment: Pick<SandboxFixture, "pidnap" | "waitForPidnapProcessRunning" | "ingressUrl">,
  processName: OnDemandProcessName,
): Promise<void> {
  const processConfig = ON_DEMAND_PROCESSES[processName];
  await startOnDemandProcessShared({
    deployment,
    processName,
    processConfig,
    waitForHostRoute: async (params) => {
      await waitForHostRoute(deployment, params);
    },
  });
}

export async function projectDeployment(params?: { name?: string }): Promise<SandboxFixture> {
  return await createProjectDeployment({
    image: sandboxImage,
    name: params?.name ?? `jonasland-playwright-${randomUUID()}`,
  });
}
