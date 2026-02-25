import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import {
  createRegistryClient,
  type RegistryClient,
} from "../../../services/registry-service/src/client.ts";
import {
  createClient as createPidnapClient,
  type Client as PidnapClient,
} from "../../../packages/pidnap/src/api/client.ts";
import {
  sanitizeNamePart,
  MAX_CANONICAL_MACHINE_NAME_LENGTH,
} from "../../../sandbox/providers/naming.ts";
import { FlyProvider } from "../../../sandbox/providers/fly/provider.ts";
import {
  assertIptablesRedirect,
  waitForHealthyWithLogs,
  waitForPidnapHostRoute,
  waitForPidnapProcessRunning,
  type ProjectDeployment,
} from "./docker-project-deployment.ts";

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
  const response = await fetch(`https://api.machines.dev${params.path}`, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
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
  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, params.ingressBaseUrl);
    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    headers.set("host", params.hostHeader);
    headers.delete("content-length");

    const body = method === "GET" || method === "HEAD" ? undefined : await request.clone().text();
    if (body !== undefined) {
      headers.set("content-length", Buffer.byteLength(body, "utf-8").toString());
    }

    const requestInit: RequestInit = {
      method,
      headers,
      body,
    };

    const initWithDuplex = requestInit as RequestInit & { duplex?: "half" };
    if (body !== undefined) {
      initWithDuplex.duplex = "half";
    }

    return await fetch(targetUrl, initWithDuplex);
  };
}

function createFlyCaddyApiClient(params: {
  ingressBaseUrl: string;
  hostHeader?: string;
}): CaddyClient {
  const caddy = new CaddyClient({ adminUrl: params.ingressBaseUrl });

  caddy.request = async (path: string, options: RequestInit = {}): Promise<Response> => {
    const url = new URL(path, params.ingressBaseUrl);
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    headers.delete("sec-fetch-mode");
    headers.delete("sec-fetch-site");
    headers.delete("sec-fetch-dest");
    headers.delete("origin");

    if (params.hostHeader) {
      headers.set("host", params.hostHeader);
    }

    const body =
      options.body === undefined || options.body === null
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : await new Response(options.body).text();

    return await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        url,
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
  };

  return caddy;
}

async function waitForRegistryReady(params: {
  client: RegistryClient;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await params.client.routes.caddyLoadInvocation({ apply: false });
      return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("timed out waiting for registry service");
}

function baseUrlFromPublicServiceUrl(publicServiceUrl: string): string | null {
  try {
    const parsed = new URL(publicServiceUrl);
    const separator = parsed.hostname.indexOf("__");
    if (separator <= 0) return null;
    const suffixHost = parsed.hostname.slice(separator + 2);
    if (!suffixHost) return null;
    return `${parsed.protocol}//${suffixHost}`;
  } catch {
    return null;
  }
}

async function resolveIngressBaseUrl(params: {
  fallbackIngressBaseUrl: string;
  registry: RegistryClient;
}): Promise<string> {
  try {
    const response = await params.registry.getPublicURL({
      internalURL: "http://events.iterate.localhost/healthz",
    });
    return baseUrlFromPublicServiceUrl(response.publicURL) ?? params.fallbackIngressBaseUrl;
  } catch {
    return params.fallbackIngressBaseUrl;
  }
}

async function waitForRuntimeReady(params: {
  exec: (cmd: string | string[]) => Promise<{ exitCode: number; output: string }>;
  pidnap: PidnapClient;
  registry: RegistryClient;
}): Promise<void> {
  const pidnapRouteDeadline = Date.now() + 90_000;
  while (Date.now() < pidnapRouteDeadline) {
    const proxiedList = await params.exec(
      "curl -fsS -X POST -H 'Host: pidnap.iterate.localhost' -H 'Content-Type: application/json' --data '{}' http://127.0.0.1/rpc/processes/list",
    );
    if (proxiedList.exitCode === 0 && proxiedList.output.includes('\"name\":\"caddy\"')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  for (const processName of ["caddy", "registry", "events"] as const) {
    await waitForPidnapProcessRunning({
      client: params.pidnap,
      target: processName,
      timeoutMs: 90_000,
    });
  }

  await waitForRegistryReady({
    client: params.registry,
    timeoutMs: 90_000,
  });
}

export interface FlyProjectDeploymentParams {
  image: string;
  name?: string;
  env?: Record<string, string> | string[];
}

export async function flyProjectDeployment(
  params: FlyProjectDeploymentParams,
): Promise<ProjectDeployment> {
  const rawEnv = process.env as Record<string, string | undefined>;
  const flyApiToken = rawEnv.FLY_API_TOKEN;
  if (!flyApiToken) {
    throw new Error("FLY_API_TOKEN is required for Fly project deployments");
  }

  const flyBaseDomain = rawEnv.FLY_BASE_DOMAIN ?? "fly.dev";
  const externalId = normalizeFlyExternalId(params.name);
  const fallbackIngressBaseUrl = `http://${externalId}.${flyBaseDomain}`;

  const provider = new FlyProvider(rawEnv);
  const envRecord = toEnvRecord(params.env);
  const sandbox = await provider.create({
    externalId,
    name: params.name ?? externalId,
    envVars: {
      ...envRecord,
      ITERATE_PUBLIC_BASE_URL: envRecord.ITERATE_PUBLIC_BASE_URL ?? fallbackIngressBaseUrl,
      ITERATE_PUBLIC_BASE_URL_TYPE: envRecord.ITERATE_PUBLIC_BASE_URL_TYPE ?? "prefixed",
    },
    providerSnapshotId: params.image,
  });

  let deleted = false;
  let machineId: string | undefined;

  const resolveMachineId = async (): Promise<string> => {
    if (machineId) return machineId;
    machineId =
      sandbox.machineId ??
      (await resolveFlyMachineId({ token: flyApiToken, appName: sandbox.appName }));
    return machineId;
  };

  let ingressBaseUrl = fallbackIngressBaseUrl;
  let pidnap = createPidnapClient({
    url: `${ingressBaseUrl}/rpc`,
    fetch: createFlyHostRoutedFetch({
      ingressBaseUrl,
      hostHeader: "pidnap.iterate.localhost",
    }),
  });
  let caddy = createFlyCaddyApiClient({
    ingressBaseUrl,
    hostHeader: "caddy-admin.iterate.localhost",
  });
  let registry = createRegistryClient({
    url: `${ingressBaseUrl}/orpc`,
    fetch: createFlyHostRoutedFetch({
      ingressBaseUrl,
      hostHeader: "registry.iterate.localhost",
    }),
  });

  const refreshClients = async () => {
    ingressBaseUrl = await resolveIngressBaseUrl({
      fallbackIngressBaseUrl,
      registry,
    });

    pidnap = createPidnapClient({
      url: `${ingressBaseUrl}/rpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl,
        hostHeader: "pidnap.iterate.localhost",
      }),
    });
    caddy = createFlyCaddyApiClient({
      ingressBaseUrl,
      hostHeader: "caddy-admin.iterate.localhost",
    });
    registry = createRegistryClient({
      url: `${ingressBaseUrl}/orpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl,
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
    await waitForRuntimeReady({
      exec,
      pidnap,
      registry,
    });

    await refreshClients();
  };

  try {
    await waitReady();
  } catch (error) {
    if (!deleted) {
      await sandbox.delete().catch(() => {});
      deleted = true;
    }
    throw error;
  }

  const deployment: ProjectDeployment = {
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
      deployment.pidnap = pidnap;
      deployment.caddy = caddy;
      deployment.registry = registry;
      await waitReady();
    },
    async [Symbol.asyncDispose]() {
      if (deleted) return;
      deleted = true;
      await sandbox.delete().catch(() => {});
    },
  };

  return deployment;
}
