import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

type ProxyService = "registry" | "pidnap" | "events" | "orders" | "docs" | "home" | "outerbase";

type CfProxyClient = {
  setRoute(input: {
    route: string;
    target: string;
    headers?: Record<string, string>;
    metadata?: Record<string, unknown>;
    ttlSeconds?: number | null;
  }): Promise<unknown>;
};

export type CfProxyRouteSet = {
  runId: string;
  workerBaseUrl: string;
  target: string;
  hosts: Record<ProxyService, string>;
  urls: {
    registry: string;
    pidnap: string;
    events: string;
    orders: string;
    docs: string;
    home: string;
    outerbase: string;
  };
};

export type RegisterCfProxyRoutesParams = {
  targetBaseUrl: string;
  runId: string;
  ttlSeconds?: number;
  workerBaseUrl?: string;
  apiToken?: string;
  logger?: (message: string) => void;
};

const DEFAULT_CF_PROXY_BASE_URL = "https://admin.proxy.iterate.com";
const MAX_RUN_ID_LENGTH = 48;

function sanitizeRunId(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`Invalid run id: "${raw}"`);
  }
  return normalized.slice(0, MAX_RUN_ID_LENGTH);
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function buildServiceHost(service: ProxyService, runId: string): string {
  return `${service}__${runId}.proxy.iterate.com`;
}

function createClient(params: { workerBaseUrl: string; apiToken: string }): CfProxyClient {
  const { workerBaseUrl, apiToken } = params;
  return createORPCClient(
    new RPCLink({
      url: `${workerBaseUrl}/api/orpc/`,
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    }),
  ) as unknown as CfProxyClient;
}

export async function registerCfProxyRoutes(
  params: RegisterCfProxyRoutesParams,
): Promise<CfProxyRouteSet> {
  const log = params.logger ?? (() => {});
  const runId = sanitizeRunId(params.runId);
  const workerBaseUrl = normalizeBaseUrl(
    params.workerBaseUrl ?? process.env.CF_PROXY_WORKER_BASE_URL ?? DEFAULT_CF_PROXY_BASE_URL,
  );
  const apiToken = params.apiToken ?? process.env.CF_PROXY_WORKER_API_TOKEN;
  if (!apiToken) {
    throw new Error("Missing CF proxy worker API token (CF_PROXY_WORKER_API_TOKEN)");
  }

  const target = new URL(params.targetBaseUrl).toString();
  const ttlSeconds = params.ttlSeconds ?? 6 * 60 * 60;
  const client = createClient({ workerBaseUrl, apiToken });

  const hosts: Record<ProxyService, string> = {
    registry: buildServiceHost("registry", runId),
    pidnap: buildServiceHost("pidnap", runId),
    events: buildServiceHost("events", runId),
    orders: buildServiceHost("orders", runId),
    docs: buildServiceHost("docs", runId),
    home: buildServiceHost("home", runId),
    outerbase: buildServiceHost("outerbase", runId),
  };

  const routeEntries = Object.entries(hosts) as Array<[ProxyService, string]>;
  for (const [service, host] of routeEntries) {
    await client.setRoute({
      route: host,
      target,
      headers: {
        "x-iterate-proxy-service": service,
        "x-iterate-proxy-run-id": runId,
        "x-iterate-proxy-route-host": host,
      },
      metadata: {
        managedBy: "jonasland/sandbox/scripts/fly-poc.ts",
        service,
        runId,
      },
      ttlSeconds,
    });
    log(`cf-proxy route set: ${host} -> ${target}`);
  }

  return {
    runId,
    workerBaseUrl,
    target,
    hosts,
    urls: {
      registry: `https://${hosts.registry}`,
      pidnap: `https://${hosts.pidnap}`,
      events: `https://${hosts.events}`,
      orders: `https://${hosts.orders}`,
      docs: `https://${hosts.docs}`,
      home: `https://${hosts.home}`,
      outerbase: `https://${hosts.outerbase}`,
    },
  };
}

export function resolveCfProxyRunId(defaultId: string): string {
  return sanitizeRunId(
    process.env.JONASLAND_CF_PROXY_RUN_ID ??
      process.env.JONASLAND_VITEST_TEST_ID ??
      process.env.VITEST_TEST_ID ??
      defaultId,
  );
}
