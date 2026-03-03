import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRegistryClient, type RegistryClient } from "@iterate-com/registry-service/client";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import {
  sanitizeNamePart,
  MAX_CANONICAL_MACHINE_NAME_LENGTH,
} from "@iterate-com/sandbox/providers/naming";
import { FlyProvider } from "@iterate-com/sandbox/providers/fly";
import {
  assertIptablesRedirect,
  waitForHealthyWithLogs,
  waitForHttpOk,
  waitForPidnapHostRoute,
  waitForPidnapProcessRunning,
  type DeploymentRuntime,
} from "./docker-deployment.ts";

type FlyExecResponse = {
  exit_code?: number;
  stdout?: string;
  stderr?: string;
};

type FlyMachineRecord = {
  id?: string;
  name?: string;
  config?: {
    metadata?: Record<string, unknown>;
  };
};

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

type IngressRouteHeaders = Record<string, string>;

type IngressRoutePatternInput = {
  pattern: string;
  target: string;
  headers?: IngressRouteHeaders;
};

type IngressRoutePatternRecord = {
  patternId: number;
  pattern: string;
  target: string;
  headers: IngressRouteHeaders;
  createdAt: string;
  updatedAt: string;
};

type IngressRouteRecord = {
  routeId: string;
  metadata: Record<string, unknown>;
  patterns: IngressRoutePatternRecord[];
  createdAt: string;
  updatedAt: string;
};

type IngressProxyClient = {
  createRoute(input: {
    metadata?: Record<string, unknown>;
    patterns: IngressRoutePatternInput[];
  }): Promise<IngressRouteRecord>;
  deleteRoute(input: { routeId: string }): Promise<{ deleted: boolean }>;
};

type IngressProxyConfig = {
  baseUrl: string;
  domain: string;
  apiToken: string;
};

type FlyIngressRouteSet = {
  baseHost: string;
  wildcardHostPattern: string;
  routeIds: string[];
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  const directCode =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code ?? undefined)
      : undefined;
  if (directCode) return directCode;

  const cause =
    "cause" in error && (error as { cause?: unknown }).cause
      ? (error as { cause: unknown }).cause
      : undefined;
  if (!cause || cause === error) return undefined;
  return errorCode(cause);
}

function isRetriableSocketError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  if (!code) return false;
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

async function withRetriableSocketErrors<T>(task: () => Promise<T>): Promise<T> {
  const maxAttempts = 10;
  let attempt = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetriableSocketError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200 * attempt, 1_500)));
      attempt += 1;
    }
  }
}

function toEnvRecord(env?: Record<string, string> | string[]): Record<string, string> {
  if (!env) return {};
  if (!Array.isArray(env)) return env;

  const record: Record<string, string> = {};
  for (const entry of env) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1);
    if (key.length === 0) continue;
    record[key] = value;
  }
  return record;
}

function normalizeFlyExternalId(value?: string): string {
  const fallback = `jonasland-e2e-fly-${randomUUID().slice(0, 8)}`;
  const normalized = sanitizeNamePart(value ?? fallback)
    .slice(0, MAX_CANONICAL_MACHINE_NAME_LENGTH)
    .replace(/-+$/, "");

  if (normalized.length > 0) return normalized;

  return sanitizeNamePart(fallback).slice(0, MAX_CANONICAL_MACHINE_NAME_LENGTH).replace(/-+$/, "");
}

async function flyApi<T>(params: {
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const response = await withRetriableSocketErrors(
    async () =>
      await fetch(`https://api.machines.dev${params.path}`, {
        method: params.method,
        headers: {
          Authorization: `Bearer ${params.token}`,
          "content-type": "application/json",
        },
        body: params.body === undefined ? undefined : JSON.stringify(params.body),
      }),
  ).catch((error) => {
    throw new Error(`Fly API transport failed for ${params.method} ${params.path}`, {
      cause: error,
    });
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Fly API ${params.method} ${params.path} failed (${response.status}): ${text}`);
  }

  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

function resolveSandboxMachine(machines: FlyMachineRecord[]): FlyMachineRecord | null {
  const byName = machines.find((machine) => machine.name === "sandbox");
  if (byName) return byName;

  const byMetadata = machines.find((machine) => {
    return machine.config?.metadata?.["com.iterate.sandbox"] === "true";
  });
  if (byMetadata) return byMetadata;

  if (machines.length === 1) return machines[0] ?? null;
  return null;
}

async function resolveFlyMachineId(params: { token: string; appName: string }): Promise<string> {
  const machines = await flyApi<FlyMachineRecord[]>({
    token: params.token,
    method: "GET",
    path: `/v1/apps/${encodeURIComponent(params.appName)}/machines`,
  });

  const resolved = resolveSandboxMachine(machines ?? []);
  const machineId = resolved?.id;
  if (!machineId) {
    throw new Error(`Could not resolve Fly machine id for app ${params.appName}`);
  }

  return machineId;
}

function createFlyHostRoutedFetch(params: {
  ingressBaseUrl: string;
  hostHeader: string;
}): (request: Request) => Promise<Response> {
  const serviceName = params.hostHeader
    .replace(/\.iterate\.localhost$/i, "")
    .trim()
    .toLowerCase();
  const ingressBase = new URL(params.ingressBaseUrl);
  const ingressHostParts = ingressBase.hostname.split(".");
  const deploymentId = ingressHostParts[0] ?? "";
  const ingressDomain = ingressHostParts.slice(1).join(".");

  if (!deploymentId || !ingressDomain) {
    throw new Error(`invalid ingress base host for Fly service routing: ${ingressBase.hostname}`);
  }

  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const targetUrl = new URL(params.ingressBaseUrl);
    targetUrl.hostname = `${serviceName}__${deploymentId}.${ingressDomain}`;
    targetUrl.pathname = requestUrl.pathname;
    targetUrl.search = requestUrl.search;
    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    headers.set("connection", "close");
    headers.delete("host");
    headers.delete("content-length");

    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await request
            .clone()
            .arrayBuffer()
            .then((buffer) => Buffer.from(buffer));
    if (body !== undefined) {
      headers.set("content-length", body.byteLength.toString());
    }

    return await withRetriableSocketErrors(async () => {
      return await new Promise<Response>((resolve, reject) => {
        const requestImpl = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
        const req = requestImpl(
          targetUrl,
          {
            method,
            headers: Object.fromEntries(headers.entries()),
          },
          (res) => {
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

            const status = res.statusCode ?? 500;
            const responseBody =
              status === 204 || status === 304
                ? undefined
                : (Readable.toWeb(res as unknown as Readable) as ReadableStream<Uint8Array>);
            resolve(
              new Response(responseBody, {
                status,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          },
        );

        req.on("error", reject);
        if (body !== undefined) {
          req.write(body);
        }
        req.end();
      });
    });
  };
}

function createFlyCaddyApiClient(params: {
  ingressBaseUrl: string;
  hostHeader?: string;
}): CaddyClient {
  const serviceName = (params.hostHeader ?? "")
    .replace(/\.iterate\.localhost$/i, "")
    .trim()
    .toLowerCase();
  const ingressBase = new URL(params.ingressBaseUrl);
  const ingressHostParts = ingressBase.hostname.split(".");
  const deploymentId = ingressHostParts[0] ?? "";
  const ingressDomain = ingressHostParts.slice(1).join(".");
  if (serviceName.length > 0 && (!deploymentId || !ingressDomain)) {
    throw new Error(`invalid ingress base host for Fly service routing: ${ingressBase.hostname}`);
  }
  const caddy = new CaddyClient({ adminUrl: params.ingressBaseUrl });

  caddy.request = async (path: string, options: RequestInit = {}): Promise<Response> => {
    const baseUrl = new URL(params.ingressBaseUrl);
    if (serviceName.length > 0) {
      baseUrl.hostname = `${serviceName}__${deploymentId}.${ingressDomain}`;
    }
    const pathValue = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(pathValue, baseUrl);
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("connection", "close");

    headers.delete("sec-fetch-mode");
    headers.delete("sec-fetch-site");
    headers.delete("sec-fetch-dest");
    headers.delete("origin");

    headers.delete("host");

    const body =
      options.body === undefined || options.body === null
        ? undefined
        : Buffer.from(await new Response(options.body).arrayBuffer());
    if (body !== undefined) {
      headers.set("content-length", body.byteLength.toString());
    }
    if (body === undefined) {
      headers.delete("content-length");
    }

    return await withRetriableSocketErrors(async () => {
      return await new Promise<Response>((resolve, reject) => {
        const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = requestImpl(
          url,
          {
            method,
            headers: Object.fromEntries(headers.entries()),
          },
          (res) => {
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

            const status = res.statusCode ?? 500;
            const responseBody =
              status === 204 || status === 304
                ? undefined
                : (Readable.toWeb(res as unknown as Readable) as ReadableStream<Uint8Array>);
            resolve(
              new Response(responseBody, {
                status,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          },
        );

        req.on("error", reject);
        if (body !== undefined) {
          req.write(body);
        }
        req.end();
      });
    });
  };

  return caddy;
}

async function waitForHostResolution(params: { host: string; timeoutMs?: number }): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 240_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await dnsLookup(params.host);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`timed out waiting for DNS resolution of ${params.host}`, { cause: lastError });
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveIngressProxyConfig(rawEnv: Record<string, string | undefined>): IngressProxyConfig {
  const baseUrl = normalizeBaseUrl(
    (
      rawEnv.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
      rawEnv.INGRESS_PROXY_BASE_URL ??
      DEFAULT_INGRESS_PROXY_BASE_URL
    ).trim(),
  );
  const domain = (
    rawEnv.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
    rawEnv.INGRESS_PROXY_DOMAIN ??
    DEFAULT_INGRESS_PROXY_DOMAIN
  ).trim();
  const apiToken = (
    rawEnv.INGRESS_PROXY_API_TOKEN ??
    rawEnv.INGRESS_PROXY_E2E_API_TOKEN ??
    ""
  ).trim();

  if (!baseUrl) {
    throw new Error(
      "Missing ingress proxy base URL (set JONASLAND_E2E_INGRESS_PROXY_BASE_URL or INGRESS_PROXY_BASE_URL)",
    );
  }
  if (!domain) {
    throw new Error(
      "Missing ingress proxy domain (set JONASLAND_E2E_INGRESS_PROXY_DOMAIN or INGRESS_PROXY_DOMAIN)",
    );
  }
  if (!apiToken) {
    throw new Error(
      "Missing ingress proxy API token (set INGRESS_PROXY_API_TOKEN or INGRESS_PROXY_E2E_API_TOKEN)",
    );
  }

  return { baseUrl, domain, apiToken };
}

function resolveIngressProxyDomain(rawEnv: Record<string, string | undefined>): string {
  return (
    rawEnv.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
    rawEnv.INGRESS_PROXY_DOMAIN ??
    DEFAULT_INGRESS_PROXY_DOMAIN
  ).trim();
}

function createIngressProxyClient(config: IngressProxyConfig): IngressProxyClient {
  const link = new RPCLink({
    url: `${config.baseUrl}/api/orpc`,
    fetch: async (request: URL | Request, init?: RequestInit) => {
      const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
      headers.set("authorization", `Bearer ${config.apiToken}`);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return await fetch(request, { ...init, headers });
    },
  });
  return createORPCClient(link) as IngressProxyClient;
}

function resolveFlyIngressHosts(params: { testId: string; ingressProxyDomain: string }): {
  baseHost: string;
  wildcardHostPattern: string;
} {
  return {
    baseHost: `${params.testId}.${params.ingressProxyDomain}`,
    wildcardHostPattern: `*__${params.testId}.${params.ingressProxyDomain}`,
  };
}

async function createFlyIngressRoutes(params: {
  client: IngressProxyClient;
  testId: string;
  ingressProxyDomain: string;
  targetUrl: string;
}): Promise<FlyIngressRouteSet> {
  const hosts = resolveFlyIngressHosts({
    testId: params.testId,
    ingressProxyDomain: params.ingressProxyDomain,
  });

  const routeIds: string[] = [];
  try {
    const baseRoute = await params.client.createRoute({
      metadata: {
        source: "jonasland-fly-deployment",
        testId: params.testId,
        routeType: "base",
      },
      patterns: [
        {
          pattern: hosts.baseHost,
          target: params.targetUrl,
          headers: {
            Host: hosts.baseHost,
          },
        },
      ],
    });
    routeIds.push(baseRoute.routeId);

    const wildcardRoute = await params.client.createRoute({
      metadata: {
        source: "jonasland-fly-deployment",
        testId: params.testId,
        routeType: "service-wildcard",
      },
      patterns: [
        {
          pattern: hosts.wildcardHostPattern,
          target: params.targetUrl,
        },
      ],
    });
    routeIds.push(wildcardRoute.routeId);
  } catch (error) {
    for (const routeId of routeIds.reverse()) {
      await params.client.deleteRoute({ routeId }).catch(() => {});
    }
    throw new Error(
      `failed creating ingress routes for fly deployment ${params.testId} (${hosts.baseHost}, ${hosts.wildcardHostPattern})`,
      { cause: error },
    );
  }

  return {
    baseHost: hosts.baseHost,
    wildcardHostPattern: hosts.wildcardHostPattern,
    routeIds,
  };
}

async function deleteFlyIngressRoutes(params: {
  client: IngressProxyClient;
  routeIds: string[];
}): Promise<void> {
  for (const routeId of [...params.routeIds].reverse()) {
    await params.client.deleteRoute({ routeId });
  }
}

async function waitForPidnapHealthy(params: {
  client: PidnapClient;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await params.client.health();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("timed out waiting for pidnap health", { cause: lastError });
}

async function waitForHostHealthViaExec(params: {
  exec: (cmd: string | string[]) => Promise<{ exitCode: number; output: string }>;
  host: string;
  path: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const cmd = `curl -fsS -H 'Host: ${params.host}' http://127.0.0.1${path}`;

  let lastOutput = "";
  while (Date.now() < deadline) {
    const response = await params.exec(["sh", "-ec", cmd]).catch((error) => ({
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
    }));

    if (response.exitCode === 0) return;
    lastOutput = response.output;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `timed out waiting for ${params.host}${path} via machine loopback\n${lastOutput}`,
  );
}

async function waitForRuntimeReady(params: {
  ingressBaseUrl: string;
  pidnap: PidnapClient;
  exec: (cmd: string | string[]) => Promise<{ exitCode: number; output: string }>;
}): Promise<void> {
  await waitForHttpOk({
    url: `${params.ingressBaseUrl}/healthz`,
    timeoutMs: 180_000,
  });
  try {
    await waitForPidnapHealthy({
      client: params.pidnap,
      timeoutMs: 120_000,
    });
  } catch (error) {
    if (!isRetriableSocketError(error)) throw error;
    await waitForPidnapHostRoute({
      deployment: {
        exec: params.exec,
      },
      timeoutMs: 120_000,
    });
  }

  await Promise.all(
    (["registry", "events"] as const).map(async (processName) => {
      try {
        await waitForPidnapProcessRunning({
          client: params.pidnap,
          target: processName,
          timeoutMs: 120_000,
        });
      } catch (error) {
        if (!isRetriableSocketError(error)) throw error;
        await waitForHostHealthViaExec({
          exec: params.exec,
          host: `${processName}.iterate.localhost`,
          path: "/api/service/health",
          timeoutMs: 120_000,
        });
      }
    }),
  );
}

export interface FlyDeploymentRuntimeCreateParams {
  flyImage: string;
  name?: string;
  env?: Record<string, string> | string[];
}

export interface FlyDeploymentLocator {
  provider: "fly";
  appName: string;
  machineId?: string;
}

export async function flyDeploymentRuntimeCreate(
  params: FlyDeploymentRuntimeCreateParams,
): Promise<{ runtime: DeploymentRuntime; deploymentLocator: FlyDeploymentLocator }> {
  const rawEnv = process.env as Record<string, string | undefined>;
  const flyApiToken = rawEnv.FLY_API_TOKEN;
  if (!flyApiToken) {
    throw new Error("FLY_API_TOKEN is required for Fly project deployments");
  }

  const flyBaseDomain = rawEnv.FLY_BASE_DOMAIN ?? "fly.dev";
  const externalId = normalizeFlyExternalId(params.name);
  const flyPublicBaseUrl = `https://${externalId}.${flyBaseDomain}`;
  const ingressBaseUrlFromRoute = flyPublicBaseUrl;
  const clientBaseUrlFromRoute = ingressBaseUrlFromRoute;

  const provider = new FlyProvider(rawEnv);
  const envRecord = toEnvRecord(params.env);
  const createSandbox = async () =>
    await provider.create({
      externalId,
      name: params.name ?? externalId,
      envVars: {
        ...envRecord,
        ITERATE_PUBLIC_BASE_URL: envRecord.ITERATE_PUBLIC_BASE_URL ?? flyPublicBaseUrl,
        ITERATE_PUBLIC_BASE_URL_TYPE: envRecord.ITERATE_PUBLIC_BASE_URL_TYPE ?? "subdomain",
      },
      providerSnapshotId: params.flyImage,
    });

  const sandbox = await (async () => {
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await createSandbox();
      } catch (error) {
        if (!isRetriableSocketError(error)) {
          throw error;
        }

        const recoveredMachineId = await resolveFlyMachineId({
          token: flyApiToken,
          appName: externalId,
        }).catch(() => undefined);

        if (recoveredMachineId) {
          const recovered = provider.getWithMachineId({
            providerId: externalId,
            machineId: recoveredMachineId,
          });
          if (recovered) return recovered;
        }

        if (attempt >= attempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }

    throw new Error(`failed to create or recover Fly sandbox ${externalId}`);
  })();

  let deleted = false;
  let machineId: string | undefined;

  const resolveMachineId = async (): Promise<string> => {
    if (machineId) return machineId;
    machineId =
      sandbox.machineId ??
      (await resolveFlyMachineId({ token: flyApiToken, appName: sandbox.appName }));
    return machineId;
  };

  let ingressBaseUrl = ingressBaseUrlFromRoute;
  let clientBaseUrl = clientBaseUrlFromRoute;
  let pidnap = createPidnapClient({
    url: `${clientBaseUrl}/rpc`,
    fetch: createFlyHostRoutedFetch({
      ingressBaseUrl: clientBaseUrl,
      hostHeader: "pidnap.iterate.localhost",
    }),
  });
  let caddy = createFlyCaddyApiClient({
    ingressBaseUrl: clientBaseUrl,
    hostHeader: "caddy.iterate.localhost",
  });
  let registry = createRegistryClient({
    url: `${clientBaseUrl}/orpc`,
    fetch: createFlyHostRoutedFetch({
      ingressBaseUrl: clientBaseUrl,
      hostHeader: "registry.iterate.localhost",
    }),
  });

  const refreshClients = async () => {
    ingressBaseUrl = ingressBaseUrlFromRoute;
    clientBaseUrl = ingressBaseUrl;

    pidnap = createPidnapClient({
      url: `${clientBaseUrl}/rpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl: clientBaseUrl,
        hostHeader: "pidnap.iterate.localhost",
      }),
    });
    caddy = createFlyCaddyApiClient({
      ingressBaseUrl: clientBaseUrl,
      hostHeader: "caddy.iterate.localhost",
    });
    registry = createRegistryClient({
      url: `${clientBaseUrl}/orpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl: clientBaseUrl,
        hostHeader: "registry.iterate.localhost",
      }),
    });
  };

  const exec = async (cmd: string | string[]): Promise<{ exitCode: number; output: string }> => {
    const argv = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;

    const resolvedMachineId = await resolveMachineId();
    const payload = await flyApi<FlyExecResponse>({
      token: flyApiToken,
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(sandbox.appName)}/machines/${encodeURIComponent(resolvedMachineId)}/exec`,
      body: {
        command: argv,
        timeout: 120,
      },
    });

    const exitCode = payload.exit_code ?? 0;
    const stdout = payload.stdout ?? "";
    const stderr = payload.stderr ?? "";

    return {
      exitCode,
      output: `${stdout}${stderr}`,
    };
  };

  const waitReady = async () => {
    let step = "wait-for-runtime-ready";
    try {
      await waitForRuntimeReady({
        ingressBaseUrl,
        pidnap,
        exec,
      });

      step = "refresh-host-routed-clients";
      await refreshClients();
    } catch (error) {
      throw new Error(`fly runtime bootstrap failed during: ${step}`, { cause: error });
    }
  };

  try {
    await waitReady();
  } catch (error) {
    const bootstrapLogs = await exec([
      "sh",
      "-ec",
      'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 200 "$f"; done 2>/dev/null || true',
    ]).catch((logsError) => ({
      exitCode: 1,
      output: `failed to fetch bootstrap logs: ${logsError instanceof Error ? logsError.message : String(logsError)}`,
    }));

    const keepFailedApp = process.env.JONASLAND_E2E_KEEP_FAILED_FLY_APP === "true";
    if (!deleted && !keepFailedApp) {
      await sandbox.delete().catch(() => {});
      deleted = true;
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${bootstrapLogs.output}${keepFailedApp ? `\nkept failing fly app for debugging: ${sandbox.appName}` : ""}`,
      { cause: error },
    );
  }

  const deployment: DeploymentRuntime = {
    ports: {
      ingress: 443,
    },
    pidnap,
    caddy,
    registry,
    ingressUrl: async () => ingressBaseUrl,
    exec,
    logs: async () => {
      const result = await exec([
        "sh",
        "-ec",
        'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 200 "$f"; done 2>/dev/null || true',
      ]).catch((error) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${error instanceof Error ? error.message : String(error)}`,
      }));
      return result.output;
    },
    waitForHealthyWithLogs: async ({ url }) =>
      await waitForHealthyWithLogs({
        url,
        deployment,
      }),
    waitForCaddyHealthy: async ({ timeoutMs } = {}) => {
      const ingress = await deployment.ingressUrl();
      await waitForHttpOk({
        url: `${ingress}/`,
        timeoutMs: timeoutMs ?? 60_000,
      });
    },
    waitForPidnapHostRoute: async ({ timeoutMs } = {}) =>
      await waitForPidnapHostRoute({
        deployment,
        timeoutMs: timeoutMs ?? 60_000,
      }),
    assertIptablesRedirect: async () => await assertIptablesRedirect({ deployment }),
    waitForPidnapProcessRunning: async ({ target, timeoutMs }) =>
      await waitForPidnapProcessRunning({
        client: pidnap,
        target,
        timeoutMs: timeoutMs ?? 60_000,
      }),
    restart: async () => {
      await sandbox.restart();
      machineId = undefined;
      await refreshClients();
      await waitReady();
      deployment.pidnap = pidnap;
      deployment.caddy = caddy;
      deployment.registry = registry;
    },
    async [Symbol.asyncDispose]() {
      if (deleted) return;
      deleted = true;
      const cleanupErrors: string[] = [];

      await sandbox.delete().catch((error) => {
        cleanupErrors.push(
          `failed deleting fly sandbox: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      if (cleanupErrors.length > 0) {
        throw new Error(cleanupErrors.join("\n"));
      }
    },
  };

  const deploymentLocator: FlyDeploymentLocator = {
    provider: "fly",
    appName: sandbox.appName,
    machineId: await resolveMachineId().catch(() => undefined),
  };
  return { runtime: deployment, deploymentLocator };
}

export async function flyDeploymentRuntimeAttach(
  locator: FlyDeploymentLocator,
): Promise<DeploymentRuntime> {
  if (locator.provider !== "fly") {
    throw new Error(`fly attach expected provider=fly, got ${locator.provider}`);
  }

  const rawEnv = process.env as Record<string, string | undefined>;
  const flyApiToken = rawEnv.FLY_API_TOKEN;
  if (!flyApiToken) {
    throw new Error("FLY_API_TOKEN is required for Fly project deployments");
  }

  const flyBaseDomain = rawEnv.FLY_BASE_DOMAIN ?? "fly.dev";
  const ingressBaseUrlFromRoute = `https://${locator.appName}.${flyBaseDomain}`;
  const clientBaseUrlFromRoute = ingressBaseUrlFromRoute;

  const provider = new FlyProvider(rawEnv);
  const sandbox = provider.getWithMachineId({
    providerId: locator.appName,
    machineId: locator.machineId,
  });
  if (!sandbox) {
    throw new Error(`Could not attach Fly sandbox ${locator.appName}`);
  }

  await waitForHostResolution({
    host: new URL(ingressBaseUrlFromRoute).hostname,
  });

  let machineId: string | undefined = locator.machineId;

  const resolveMachineId = async (): Promise<string> => {
    if (machineId) return machineId;
    machineId =
      sandbox.machineId ??
      (await resolveFlyMachineId({ token: flyApiToken, appName: sandbox.appName }));
    return machineId;
  };

  let ingressBaseUrl = ingressBaseUrlFromRoute;
  let clientBaseUrl = clientBaseUrlFromRoute;
  let pidnap = createPidnapClient({
    url: `${clientBaseUrl}/rpc`,
    fetch: createFlyHostRoutedFetch({
      ingressBaseUrl: clientBaseUrl,
      hostHeader: "pidnap.iterate.localhost",
    }),
  });
  let caddy = createFlyCaddyApiClient({
    ingressBaseUrl: clientBaseUrl,
    hostHeader: "caddy.iterate.localhost",
  });
  let registry = createRegistryClient({
    url: `${clientBaseUrl}/orpc`,
    fetch: createFlyHostRoutedFetch({
      ingressBaseUrl: clientBaseUrl,
      hostHeader: "registry.iterate.localhost",
    }),
  });

  const refreshClients = async () => {
    ingressBaseUrl = ingressBaseUrlFromRoute;
    clientBaseUrl = ingressBaseUrl;

    pidnap = createPidnapClient({
      url: `${clientBaseUrl}/rpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl: clientBaseUrl,
        hostHeader: "pidnap.iterate.localhost",
      }),
    });
    caddy = createFlyCaddyApiClient({
      ingressBaseUrl: clientBaseUrl,
      hostHeader: "caddy.iterate.localhost",
    });
    registry = createRegistryClient({
      url: `${clientBaseUrl}/orpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl: clientBaseUrl,
        hostHeader: "registry.iterate.localhost",
      }),
    });
  };

  const exec = async (cmd: string | string[]): Promise<{ exitCode: number; output: string }> => {
    const argv = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;

    const resolvedMachineId = await resolveMachineId();
    const payload = await flyApi<FlyExecResponse>({
      token: flyApiToken,
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(sandbox.appName)}/machines/${encodeURIComponent(resolvedMachineId)}/exec`,
      body: {
        command: argv,
        timeout: 120,
      },
    });

    const exitCode = payload.exit_code ?? 0;
    const stdout = payload.stdout ?? "";
    const stderr = payload.stderr ?? "";

    return {
      exitCode,
      output: `${stdout}${stderr}`,
    };
  };

  const waitReady = async () => {
    let step = "wait-for-runtime-ready";
    try {
      await waitForRuntimeReady({
        ingressBaseUrl,
        pidnap,
        exec,
      });

      step = "refresh-host-routed-clients";
      await refreshClients();
    } catch (error) {
      throw new Error(`fly runtime attach failed during: ${step}`, { cause: error });
    }
  };

  try {
    await waitReady();
  } catch (error) {
    const bootstrapLogs = await exec([
      "sh",
      "-ec",
      'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 200 "$f"; done 2>/dev/null || true',
    ]).catch((logsError) => ({
      exitCode: 1,
      output: `failed to fetch bootstrap logs: ${logsError instanceof Error ? logsError.message : String(logsError)}`,
    }));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${bootstrapLogs.output}`,
      { cause: error },
    );
  }

  const deployment: DeploymentRuntime = {
    ports: {
      ingress: 443,
    },
    pidnap,
    caddy,
    registry,
    ingressUrl: async () => ingressBaseUrl,
    exec,
    logs: async () => {
      const result = await exec([
        "sh",
        "-ec",
        'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 200 "$f"; done 2>/dev/null || true',
      ]).catch((error) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${error instanceof Error ? error.message : String(error)}`,
      }));
      return result.output;
    },
    waitForHealthyWithLogs: async ({ url }) =>
      await waitForHealthyWithLogs({
        url,
        deployment,
      }),
    waitForCaddyHealthy: async ({ timeoutMs } = {}) => {
      const ingress = await deployment.ingressUrl();
      await waitForHttpOk({
        url: `${ingress}/`,
        timeoutMs: timeoutMs ?? 60_000,
      });
    },
    waitForPidnapHostRoute: async ({ timeoutMs } = {}) =>
      await waitForPidnapHostRoute({
        deployment,
        timeoutMs: timeoutMs ?? 60_000,
      }),
    assertIptablesRedirect: async () => await assertIptablesRedirect({ deployment }),
    waitForPidnapProcessRunning: async ({ target, timeoutMs }) =>
      await waitForPidnapProcessRunning({
        client: pidnap,
        target,
        timeoutMs: timeoutMs ?? 60_000,
      }),
    restart: async () => {
      await sandbox.restart();
      machineId = undefined;
      await refreshClients();
      await waitReady();
      deployment.pidnap = pidnap;
      deployment.caddy = caddy;
      deployment.registry = registry;
    },
    async [Symbol.asyncDispose]() {},
  };

  return deployment;
}

export async function flyDeploymentRuntime(
  params: FlyDeploymentRuntimeCreateParams,
): Promise<DeploymentRuntime> {
  const result = await flyDeploymentRuntimeCreate(params);
  return result.runtime;
}
