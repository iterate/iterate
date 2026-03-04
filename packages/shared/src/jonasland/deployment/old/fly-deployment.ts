import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import createClient, {
  type Client,
  type ClientPathsWithMethod,
  type MaybeOptionalInit,
  type MethodResponse,
} from "openapi-fetch";
import pRetry from "p-retry";
import pWaitFor from "p-wait-for";
import { createClient as createPidnapClient } from "pidnap/client";
import {
  Deployment,
  waitForHttpOk,
  type DeploymentCommandResult,
  type DeploymentIngressOpts,
  type DeploymentOpts,
} from "./deployment.ts";
import { isRetriableNetworkError, nodeHttpRequest, toEnvRecord } from "./deployment-utils.ts";
import type { components, paths } from "./fly-api/generated/openapi.gen.ts";

const NETWORK_RETRY_OPTS = {
  retries: 9,
  shouldRetry: isRetriableNetworkError,
  minTimeout: 200,
  maxTimeout: 1_500,
} as const;

const DEFAULT_FLY_ORG_SLUG = "iterate";
const DEFAULT_FLY_REGION = "lhr";
const DEFAULT_FLY_MACHINE_CPUS = 4;
const DEFAULT_FLY_MACHINE_MEMORY_MB = 4096;
const DEFAULT_FLY_MACHINE_NAME = "sandbox";
const MAX_FLY_APP_NAME_LENGTH = 63;
const FLY_WAIT_TIMEOUT_SECONDS = 300;
const FLY_MAX_WAIT_STEP_SECONDS = 60;
const PIDNAP_LOG_TAIL_CMD =
  'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 200 "$f"; done 2>/dev/null || true';

type FlyMachineLike = {
  id?: string;
  name?: string;
  config?: {
    metadata?: Record<string, string | undefined>;
  };
};

type FlyCreateMachineRequest = components["schemas"]["CreateMachineRequest"];
type FlyApiClient = Client<paths>;
type FlyApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type FlyGetPath = ClientPathsWithMethod<FlyApiClient, "get">;
type FlyPostPath = ClientPathsWithMethod<FlyApiClient, "post">;
type FlyDeletePath = ClientPathsWithMethod<FlyApiClient, "delete">;
type FlyApiResponse<TData> = {
  data?: TData;
  error?: unknown;
  response: Response;
};

function sanitizeFlyNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function normalizeFlyAppName(value?: string): string {
  const fallback = `jonasland-e2e-fly-${randomUUID().slice(0, 8)}`;
  const normalized = sanitizeFlyNamePart(value ?? fallback)
    .slice(0, MAX_FLY_APP_NAME_LENGTH)
    .replace(/-+$/, "");
  if (normalized.length > 0) return normalized;
  return sanitizeFlyNamePart(fallback).slice(0, MAX_FLY_APP_NAME_LENGTH).replace(/-+$/, "");
}

function lowerErrorText(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return String(error).toLowerCase();
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = lowerErrorText(error);
  return (
    message.includes("already exists") ||
    message.includes("has already been taken") ||
    message.includes("uniqueness constraint violated")
  );
}

function isNotFoundError(error: unknown): boolean {
  const message = lowerErrorText(error);
  return message.includes("(404)") || message.includes("not found");
}

function isMachineStillActiveError(error: unknown): boolean {
  const message = lowerErrorText(error);
  return message.includes("failed_precondition") && message.includes("still active");
}

function isIpAlreadyAllocatedError(error: unknown): boolean {
  const message = lowerErrorText(error);
  return (
    message.includes("already has") &&
    (message.includes("ip") || message.includes("ipv4") || message.includes("ipv6"))
  );
}

function isWaitTimeoutError(error: unknown): boolean {
  const message = lowerErrorText(error);
  return (
    message.includes("deadline_exceeded") ||
    message.includes("(408)") ||
    message.includes("timeout")
  );
}

function throwFlyApiError(params: {
  method: FlyApiMethod;
  path: string;
  response: Response;
  error: unknown;
}): never {
  let details = "";
  try {
    details = `: ${JSON.stringify(params.error)}`;
  } catch {
    details = `: ${String(params.error)}`;
  }

  throw new Error(
    `Fly API request failed (${params.response.status}) ${params.method} ${params.path}${details}`,
  );
}

function resolveSandboxMachine(params: {
  machines: FlyMachineLike[];
  preferredName: string;
}): FlyMachineLike | null {
  const byName = params.machines.find((machine) => machine.name === params.preferredName);
  if (byName) return byName;

  const byMetadata = params.machines.find((machine) => {
    return machine.config?.metadata?.["com.iterate.sandbox"] === "true";
  });
  if (byMetadata) return byMetadata;

  if (params.machines.length === 1) return params.machines[0] ?? null;
  return null;
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

    return await pRetry(
      () => nodeHttpRequest({ url: targetUrl, method, headers, body }),
      NETWORK_RETRY_OPTS,
    );
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
    } else {
      headers.delete("content-length");
    }

    return await pRetry(() => nodeHttpRequest({ url, method, headers, body }), NETWORK_RETRY_OPTS);
  };

  return caddy;
}

async function waitForHostResolution(params: { host: string; timeoutMs?: number }): Promise<void> {
  await pWaitFor(
    async () => {
      try {
        await dnsLookup(params.host);
        return true;
      } catch {
        return false;
      }
    },
    {
      interval: 500,
      timeout: {
        milliseconds: params.timeoutMs ?? 240_000,
        message: `timed out waiting for DNS resolution of ${params.host}`,
      },
    },
  );
}

async function waitForPidnapHealthy(params: {
  timeoutMs?: number;
  client: FlyDeployment["pidnap"];
}): Promise<void> {
  await pWaitFor(
    async () => {
      try {
        await params.client.health();
        return true;
      } catch {
        return false;
      }
    },
    {
      interval: 250,
      timeout: {
        milliseconds: params.timeoutMs ?? 120_000,
        message: "timed out waiting for pidnap health",
      },
    },
  );
}

async function waitForHostHealthViaExec(params: {
  exec: (cmd: string | string[]) => Promise<DeploymentCommandResult>;
  host: string;
  path: string;
  timeoutMs?: number;
}): Promise<void> {
  const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const cmd = `curl -fsS -H 'Host: ${params.host}' http://127.0.0.1${path}`;
  await pWaitFor(
    async () => {
      const response = await params.exec(["sh", "-ec", cmd]).catch(() => ({ exitCode: 1 }));
      return response.exitCode === 0;
    },
    {
      interval: 250,
      timeout: {
        milliseconds: params.timeoutMs ?? 120_000,
        message: `timed out waiting for ${params.host}${path} via machine loopback`,
      },
    },
  );
}

async function waitForRuntimeReady(params: {
  ingressBaseUrl: string;
  pidnap: FlyDeployment["pidnap"];
  exec: (cmd: string | string[]) => Promise<DeploymentCommandResult>;
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
    if (!isRetriableNetworkError(error)) throw error;
    await pWaitFor(
      async () => {
        const result = await params
          .exec(
            "curl -fsS -X POST -H 'Host: pidnap.iterate.localhost' -H 'Content-Type: application/json' --data '{}' http://127.0.0.1/rpc/processes/list",
          )
          .catch(() => ({ exitCode: 1, output: "" }));
        return result.exitCode === 0 && result.output.includes('"name":"caddy"');
      },
      {
        interval: 250,
        timeout: {
          milliseconds: 120_000,
          message: "timed out waiting for pidnap fallback readiness via exec",
        },
      },
    );
  }

  await Promise.all(
    (["registry", "events"] as const).map(async (processName) => {
      try {
        await params.pidnap.processes.waitForRunning({
          processSlug: processName,
          timeoutMs: 120_000,
          pollIntervalMs: 250,
          includeLogs: true,
          logTailLines: 120,
        });
      } catch (error) {
        if (!isRetriableNetworkError(error)) throw error;
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

export interface FlyDeploymentLocator {
  provider: "fly";
  appName: string;
  machineId?: string;
}

export interface FlyDeploymentOpts extends DeploymentOpts {
  flyImage?: string;
  flyApiToken?: string;
  flyBaseDomain?: string;
  flyApiBaseUrl?: string;
  flyApiClient?: FlyApiClient;
  flyOrgSlug?: string;
  flyNetwork?: string;
  flyRegion?: string;
  flyMachineCpus?: number;
  flyMachineMemoryMb?: number;
  flyMachineName?: string;
  keepFailedAppOnBootstrapFailure?: boolean;
  disposePolicy?: "delete" | "preserve";
}

export class FlyDeployment extends Deployment<FlyDeploymentOpts, FlyDeploymentLocator> {
  static override implemented = true;

  protected readonly providerName = "fly" as const;
  private flyApiClient: FlyApiClient | null = null;
  private flyBaseDomain = "";
  private appName: string | null = null;
  private machineId: string | undefined;
  private sandboxMachineName = DEFAULT_FLY_MACHINE_NAME;
  private ingressBaseUrl = "";
  private disposePolicy: "delete" | "preserve" = "delete";
  private deleted = false;

  protected override async providerCreate(opts: FlyDeploymentOpts) {
    if (!opts.flyImage) {
      throw new Error("flyImage is required");
    }

    this.resolveContext(opts);
    this.sandboxMachineName = opts.flyMachineName ?? DEFAULT_FLY_MACHINE_NAME;
    this.disposePolicy = opts.disposePolicy ?? "delete";
    this.deleted = false;

    const appName = normalizeFlyAppName(opts.name);
    this.appName = appName;
    this.machineId = undefined;
    this.ingressBaseUrl = `https://${appName}.${this.flyBaseDomain}`;

    try {
      await this.ensureAppExists(appName, opts);
      await this.ensureAppIngress(appName, opts);

      const machineId = await this.createMachine(appName, opts);
      this.machineId = machineId;

      await this.waitForMachineState({
        appName,
        machineId,
        state: "started",
      });

      this.refreshClients();

      await waitForHostResolution({
        host: new URL(this.ingressBaseUrl).hostname,
      });
      await this.waitReady();
    } catch (error) {
      const bootstrapLogs = await this.providerExec(["sh", "-ec", PIDNAP_LOG_TAIL_CMD]).catch(
        (logsError) => ({
          exitCode: 1,
          output: `failed to fetch bootstrap logs: ${logsError instanceof Error ? logsError.message : String(logsError)}`,
        }),
      );

      if (!opts.keepFailedAppOnBootstrapFailure) {
        await this.deleteFlyResources().catch(() => {});
      }

      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${bootstrapLogs.output}`,
        { cause: error },
      );
    }

    return {
      locator: {
        provider: "fly" as const,
        appName,
        machineId: this.machineId,
      },
      defaultIngressOpts: this.buildDefaultIngressOpts(),
      cleanupOnError: async () => {
        if (this.deleted) return;
        await this.deleteFlyResources().catch(() => {});
      },
    };
  }

  protected override async providerAttach(
    locator: FlyDeploymentLocator,
    opts: Partial<FlyDeploymentOpts> = {},
  ) {
    this.resolveContext(opts);
    this.sandboxMachineName = opts.flyMachineName ?? DEFAULT_FLY_MACHINE_NAME;
    this.disposePolicy = opts.disposePolicy ?? "preserve";
    this.deleted = false;

    if (locator.provider !== "fly") {
      throw new Error(`fly attach expected provider=fly, got ${locator.provider}`);
    }

    this.appName = locator.appName;
    this.machineId = locator.machineId;
    this.ingressBaseUrl = `https://${locator.appName}.${this.flyBaseDomain}`;

    await waitForHostResolution({
      host: new URL(this.ingressBaseUrl).hostname,
    });

    this.refreshClients();

    try {
      await this.waitReady();
    } catch (error) {
      const bootstrapLogs = await this.providerExec(["sh", "-ec", PIDNAP_LOG_TAIL_CMD]).catch(
        (logsError) => ({
          exitCode: 1,
          output: `failed to fetch bootstrap logs: ${logsError instanceof Error ? logsError.message : String(logsError)}`,
        }),
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${bootstrapLogs.output}`,
        { cause: error },
      );
    }

    return {
      defaultIngressOpts: this.buildDefaultIngressOpts(),
      cleanupOnError: async () => {},
    };
  }

  protected override async providerRestart(): Promise<void> {
    const appName = this.requireAppName();
    const machineId = await this.resolveMachineId();

    try {
      await this.flyCall({
        method: "POST",
        path: "/apps/{app_name}/machines/{machine_id}/restart",
        call: async () =>
          await this.flyApi.POST("/apps/{app_name}/machines/{machine_id}/restart", {
            params: this.machinePath(appName, machineId),
          }),
      });
    } catch {
      await this.flyCall({
        method: "POST",
        path: "/apps/{app_name}/machines/{machine_id}/stop",
        call: async () =>
          await this.flyApi.POST("/apps/{app_name}/machines/{machine_id}/stop", {
            params: this.machinePath(appName, machineId),
          }),
      }).catch(() => {});
      await this.flyCall({
        method: "POST",
        path: "/apps/{app_name}/machines/{machine_id}/start",
        call: async () =>
          await this.flyApi.POST("/apps/{app_name}/machines/{machine_id}/start", {
            params: this.machinePath(appName, machineId),
          }),
      });
    }

    await this.waitForMachineState({
      appName,
      machineId,
      state: "started",
    });
    this.refreshClients();
    await this.waitReady();
  }

  protected override async providerDisposeOwned(): Promise<void> {
    await this.disposeIfNeeded();
  }

  protected override async providerDisposeAttached(): Promise<void> {
    await this.disposeIfNeeded();
  }

  protected override async providerIngressUrl(): Promise<string> {
    if (!this.ingressBaseUrl) {
      throw new Error("fly ingress url not initialized");
    }
    return this.ingressBaseUrl;
  }

  protected override async providerExec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    const appName = this.requireAppName();
    const machineId = await this.resolveMachineId();
    const command = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;

    const result = await this.flyCall({
      method: "POST",
      path: "/apps/{app_name}/machines/{machine_id}/exec",
      call: async () =>
        await this.flyApi.POST("/apps/{app_name}/machines/{machine_id}/exec", {
          params: this.machinePath(appName, machineId),
          body: {
            command,
            timeout: 120,
          },
        }),
    });

    const execResponse = result as {
      exit_code?: number;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = execResponse.exit_code ?? 0;
    const stdout = execResponse.stdout ?? "";
    const stderr = execResponse.stderr ?? "";

    return {
      exitCode,
      output: `${stdout}${stderr}`,
    };
  }

  protected override async providerLogs(): Promise<string> {
    const result = await this.providerExec(["sh", "-ec", PIDNAP_LOG_TAIL_CMD]).catch((error) => ({
      exitCode: 1,
      output: `failed to fetch logs: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return result.output;
  }

  private resolveContext(opts: Partial<FlyDeploymentOpts>): void {
    const flyApiToken = opts.flyApiToken;
    const flyBaseDomain = opts.flyBaseDomain;
    if (!flyApiToken) {
      throw new Error("flyApiToken is required");
    }
    if (!flyBaseDomain) {
      throw new Error("flyBaseDomain is required");
    }

    this.flyBaseDomain = flyBaseDomain;
    this.flyApiClient =
      opts.flyApiClient ??
      createClient<paths>({
        baseUrl: opts.flyApiBaseUrl ?? "https://api.machines.dev/v1",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${flyApiToken}`,
        },
      });
  }

  private get flyApi(): FlyApiClient {
    if (!this.flyApiClient) {
      throw new Error("fly api client is not initialized");
    }
    return this.flyApiClient;
  }

  private appPath(appName: string): {
    path: {
      app_name: string;
    };
  } {
    return {
      path: {
        app_name: appName,
      },
    };
  }

  private machinePath(
    appName: string,
    machineId: string,
  ): {
    path: {
      app_name: string;
      machine_id: string;
    };
  } {
    return {
      path: {
        app_name: appName,
        machine_id: machineId,
      },
    };
  }

  private async flyCall<TData>(params: {
    method: FlyApiMethod;
    path: string;
    call: () => Promise<FlyApiResponse<TData>>;
    retry?: Parameters<typeof pRetry>[1];
  }): Promise<TData> {
    return await pRetry(async () => {
      const { data, error, response } = await params.call();
      if (error) {
        throwFlyApiError({
          method: params.method,
          path: params.path,
          response,
          error,
        });
      }
      return data as TData;
    }, params.retry ?? NETWORK_RETRY_OPTS);
  }

  private requireAppName(): string {
    if (!this.appName) {
      throw new Error("fly deployment app is not initialized");
    }
    return this.appName;
  }

  private async resolveMachineId(): Promise<string> {
    if (this.machineId) return this.machineId;
    const appName = this.requireAppName();
    this.machineId = await this.resolveMachineIdForApp(appName);
    return this.machineId;
  }

  private async resolveMachineIdForApp(appName: string): Promise<string> {
    const machines = await this.flyCall({
      method: "GET",
      path: "/apps/{app_name}/machines",
      call: async () =>
        await this.flyApi.GET("/apps/{app_name}/machines", {
          params: this.appPath(appName),
        }),
    });

    if (!Array.isArray(machines)) {
      throw new Error(`Could not resolve machines for Fly app ${appName}`);
    }
    const resolved = resolveSandboxMachine({
      machines,
      preferredName: this.sandboxMachineName,
    });
    const machineId = resolved?.id;
    if (!machineId) {
      throw new Error(`Could not resolve Fly machine id for app ${appName}`);
    }
    return machineId;
  }

  private buildMachineCreateRequest(params: {
    appName: string;
    opts: FlyDeploymentOpts;
    envRecord: Record<string, string>;
  }): FlyCreateMachineRequest {
    const machineConfig: NonNullable<FlyCreateMachineRequest["config"]> = {
      image: params.opts.flyImage,
      env: {
        ...params.envRecord,
        ITERATE_PUBLIC_BASE_URL:
          params.envRecord.ITERATE_PUBLIC_BASE_URL ??
          `https://${params.appName}.${this.flyBaseDomain}`,
        ITERATE_PUBLIC_BASE_URL_TYPE: params.envRecord.ITERATE_PUBLIC_BASE_URL_TYPE ?? "prefix",
      },
      guest: {
        cpu_kind: "shared",
        cpus: params.opts.flyMachineCpus ?? DEFAULT_FLY_MACHINE_CPUS,
        memory_mb: params.opts.flyMachineMemoryMb ?? DEFAULT_FLY_MACHINE_MEMORY_MB,
      },
      restart: {
        policy: "always",
      },
      services: [
        {
          protocol: "tcp",
          internal_port: 80,
          ports: [
            {
              port: 80,
              handlers: ["http"],
            },
            {
              port: 443,
              handlers: ["tls", "http"],
            },
          ],
        },
      ],
      metadata: {
        "com.iterate.sandbox": "true",
        "com.iterate.machine_type": "fly",
        "com.iterate.external_id": params.appName,
      },
    };

    return {
      name: this.sandboxMachineName,
      region: params.opts.flyRegion ?? DEFAULT_FLY_REGION,
      skip_launch: false,
      config: machineConfig,
    };
  }

  private async createMachine(appName: string, opts: FlyDeploymentOpts): Promise<string> {
    const envRecord = toEnvRecord(opts.env);
    const createdMachine = await this.flyCall({
      method: "POST",
      path: "/apps/{app_name}/machines",
      call: async () =>
        await this.flyApi.POST("/apps/{app_name}/machines", {
          params: this.appPath(appName),
          body: this.buildMachineCreateRequest({
            appName,
            opts,
            envRecord,
          }),
        }),
    });

    const machineId =
      (createdMachine as { id?: string }).id ?? (await this.resolveMachineIdForApp(appName));
    if (!machineId) {
      throw new Error(`Fly machine creation did not return an id for app ${appName}`);
    }
    return machineId;
  }

  private async waitForMachineState(params: {
    appName: string;
    machineId: string;
    state: "started" | "stopped" | "suspended" | "destroyed";
    timeoutSeconds?: number;
  }): Promise<void> {
    const timeoutSeconds = params.timeoutSeconds ?? FLY_WAIT_TIMEOUT_SECONDS;
    const startedAt = Date.now();

    while (true) {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const remainingSeconds = timeoutSeconds - elapsedSeconds;
      if (remainingSeconds <= 0) {
        throw new Error(
          `timed out waiting for Fly machine ${params.machineId} to reach state '${params.state}'`,
        );
      }

      const stepTimeoutSeconds = Math.max(1, Math.min(remainingSeconds, FLY_MAX_WAIT_STEP_SECONDS));
      try {
        await this.flyCall({
          method: "GET",
          path: "/apps/{app_name}/machines/{machine_id}/wait",
          call: async () =>
            await this.flyApi.GET("/apps/{app_name}/machines/{machine_id}/wait", {
              params: {
                ...this.machinePath(params.appName, params.machineId),
                query: {
                  state: params.state,
                  timeout: stepTimeoutSeconds,
                },
              },
            }),
        });
        return;
      } catch (error) {
        if (!isWaitTimeoutError(error)) {
          throw error;
        }
      }
    }
  }

  private async ensureAppExists(appName: string, opts: FlyDeploymentOpts): Promise<void> {
    try {
      await this.flyCall({
        method: "POST",
        path: "/apps",
        call: async () =>
          await this.flyApi.POST("/apps", {
            body: {
              name: appName,
              org_slug: opts.flyOrgSlug ?? DEFAULT_FLY_ORG_SLUG,
              ...(opts.flyNetwork ? { network: opts.flyNetwork } : {}),
            },
          }),
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  private async ensureAppIngress(appName: string, opts: FlyDeploymentOpts): Promise<void> {
    const assignIp = async (ipType: "v6" | "shared_v4") => {
      try {
        await this.flyCall({
          method: "POST",
          path: "/apps/{app_name}/ip_assignments",
          call: async () =>
            await this.flyApi.POST("/apps/{app_name}/ip_assignments", {
              params: this.appPath(appName),
              body: {
                type: ipType,
                org_slug: opts.flyOrgSlug ?? DEFAULT_FLY_ORG_SLUG,
                ...(opts.flyNetwork ? { network: opts.flyNetwork } : {}),
              },
            }),
        });
      } catch (error) {
        if (!isAlreadyExistsError(error) && !isIpAlreadyAllocatedError(error)) {
          throw error;
        }
      }
    };

    await assignIp("v6");
    await assignIp("shared_v4");
  }

  private async deleteFlyResources(): Promise<void> {
    const appName = this.appName;
    if (!appName) return;

    const machineId =
      this.machineId ?? (await this.resolveMachineIdForApp(appName).catch(() => undefined));
    if (machineId) {
      await this.flyCall({
        method: "DELETE",
        path: "/apps/{app_name}/machines/{machine_id}",
        call: async () =>
          await this.flyApi.DELETE("/apps/{app_name}/machines/{machine_id}", {
            params: {
              ...this.machinePath(appName, machineId),
              query: {
                force: true,
              },
            },
          }),
      }).catch((error) => {
        if (!isNotFoundError(error)) throw error;
      });
    }

    await this.flyCall({
      method: "DELETE",
      path: "/apps/{app_name}",
      call: async () =>
        await this.flyApi.DELETE("/apps/{app_name}", {
          params: this.appPath(appName),
        }),
      retry: {
        retries: 8,
        minTimeout: 500,
        maxTimeout: 3_000,
        shouldRetry: (error) => isRetriableNetworkError(error) || isMachineStillActiveError(error),
      },
    }).catch((error) => {
      if (!isNotFoundError(error)) throw error;
    });

    this.deleted = true;
  }

  private refreshClients(): void {
    this.ports.ingress = 443;
    this.pidnap = createPidnapClient({
      url: `${this.ingressBaseUrl}/rpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl: this.ingressBaseUrl,
        hostHeader: "pidnap.iterate.localhost",
      }),
    });
    this.caddy = createFlyCaddyApiClient({
      ingressBaseUrl: this.ingressBaseUrl,
      hostHeader: "caddy.iterate.localhost",
    });
    this.registry = createRegistryClient({
      url: `${this.ingressBaseUrl}/orpc`,
      fetch: createFlyHostRoutedFetch({
        ingressBaseUrl: this.ingressBaseUrl,
        hostHeader: "registry.iterate.localhost",
      }),
    });
  }

  private async waitReady(): Promise<void> {
    const exec = async (cmd: string | string[]) => await this.providerExec(cmd);
    let step = "wait-for-runtime-ready";
    try {
      await waitForRuntimeReady({
        ingressBaseUrl: this.ingressBaseUrl,
        pidnap: this.pidnap,
        exec,
      });

      step = "refresh-host-routed-clients";
      this.refreshClients();
    } catch (error) {
      throw new Error(`fly runtime bootstrap failed during: ${step}`, { cause: error });
    }
  }

  private buildDefaultIngressOpts(): DeploymentIngressOpts {
    return {
      publicBaseUrl: this.ingressBaseUrl,
      publicBaseUrlType: "prefix",
      ingressProxyTargetUrl: this.ingressBaseUrl,
    };
  }

  private async disposeIfNeeded(): Promise<void> {
    if (this.deleted) return;
    if (this.disposePolicy === "preserve") return;
    await this.deleteFlyResources();
  }

  static async create(opts: FlyDeploymentOpts): Promise<FlyDeployment> {
    const deployment = new FlyDeployment();
    await deployment.create(opts);
    return deployment;
  }

  static createWithOpts(baseOpts: Partial<FlyDeploymentOpts>) {
    const create = async (override?: Partial<FlyDeploymentOpts>): Promise<FlyDeployment> => {
      const merged = {
        ...(baseOpts as object),
        ...((override ?? {}) as object),
      } as FlyDeploymentOpts;
      return await FlyDeployment.create(merged);
    };
    return Object.assign(create, { create });
  }
}
