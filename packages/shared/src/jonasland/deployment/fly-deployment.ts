import { randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import pRetry from "p-retry";
import { Deployment, type DeploymentCommandResult, type DeploymentOpts } from "./deployment.ts";
import { isRetriableNetworkError, toEnvRecord } from "./deployment-utils.ts";
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
const DEFAULT_FLY_INTERNAL_PORT = 8080;
const DEFAULT_FLY_MACHINE_NAME = "sandbox";
const MAX_FLY_APP_NAME_LENGTH = 63;
const FLY_WAIT_TIMEOUT_SECONDS = 300;
const FLY_MAX_WAIT_STEP_SECONDS = 60;
const PIDNAP_LOG_TAIL_CMD =
  'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 200 "$f"; done 2>/dev/null || true';

type FlyApiClient = Client<paths>;
type FlyCreateMachineRequest = components["schemas"]["CreateMachineRequest"];
type FlyApiResponse<TData> = { data?: TData; error?: unknown; response: Response };
type FlyApiMethod = "GET" | "POST" | "DELETE";

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
  return normalized.length > 0
    ? normalized
    : sanitizeFlyNamePart(fallback).slice(0, MAX_FLY_APP_NAME_LENGTH).replace(/-+$/, "");
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
  const m = lowerErrorText(error);
  return (
    m.includes("already exists") ||
    m.includes("has already been taken") ||
    m.includes("uniqueness constraint violated")
  );
}

function isNotFoundError(error: unknown): boolean {
  const m = lowerErrorText(error);
  return m.includes("(404)") || m.includes("not found");
}

function isMachineStillActiveError(error: unknown): boolean {
  const m = lowerErrorText(error);
  return m.includes("failed_precondition") && m.includes("still active");
}

function isIpAlreadyAllocatedError(error: unknown): boolean {
  const m = lowerErrorText(error);
  return (
    m.includes("already has") && (m.includes("ip") || m.includes("ipv4") || m.includes("ipv6"))
  );
}

function isWaitTimeoutError(error: unknown): boolean {
  const m = lowerErrorText(error);
  return m.includes("deadline_exceeded") || m.includes("(408)") || m.includes("timeout");
}

function throwFlyApiError(params: {
  method: FlyApiMethod;
  path: string;
  response: Response;
  error: unknown;
}): never {
  const details = (() => {
    try {
      return JSON.stringify(params.error);
    } catch {
      return String(params.error);
    }
  })();
  throw new Error(
    `Fly API (${params.response.status}) ${params.method} ${params.path}: ${details}`,
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
  flyOrgSlug?: string;
  flyNetwork?: string;
  flyRegion?: string;
  flyMachineCpus?: number;
  flyMachineMemoryMb?: number;
  flyInternalPort?: number;
  flyMachineName?: string;
}

export class FlyDeployment extends Deployment<FlyDeploymentOpts, FlyDeploymentLocator> {
  private api: FlyApiClient | null = null;
  private flyBaseDomain = "";
  private appName: string | null = null;
  private machineId: string | undefined;
  private sandboxMachineName = DEFAULT_FLY_MACHINE_NAME;

  private async flyCall<TData>(p: {
    method: FlyApiMethod;
    path: string;
    call: () => Promise<FlyApiResponse<TData>>;
    retry?: Parameters<typeof pRetry>[1];
  }): Promise<TData> {
    return await pRetry(async () => {
      const { data, error, response } = await p.call();
      if (error) throwFlyApiError({ method: p.method, path: p.path, response, error });
      return data as TData;
    }, p.retry ?? NETWORK_RETRY_OPTS);
  }

  private requireApi(): FlyApiClient {
    if (!this.api) throw new Error("fly api not initialized");
    return this.api;
  }
  private requireAppName(): string {
    if (!this.appName) throw new Error("fly app not initialized");
    return this.appName;
  }
  private appPath(appName: string) {
    return { path: { app_name: appName } };
  }
  private machinePath(appName: string, machineId: string) {
    return { path: { app_name: appName, machine_id: machineId } };
  }

  private async resolveMachineId(): Promise<string> {
    if (this.machineId) return this.machineId;
    const appName = this.requireAppName();
    const machines = await this.flyCall({
      method: "GET",
      path: "/apps/{app_name}/machines",
      call: async () =>
        await this.requireApi().GET("/apps/{app_name}/machines", { params: this.appPath(appName) }),
    });
    if (!Array.isArray(machines)) throw new Error(`Could not list machines for ${appName}`);
    const match =
      machines.find((m: { name?: string }) => m.name === this.sandboxMachineName) ??
      machines.find(
        (m: { config?: { metadata?: Record<string, string | undefined> } }) =>
          m.config?.metadata?.["com.iterate.sandbox"] === "true",
      ) ??
      (machines.length === 1 ? machines[0] : null);
    const id = (match as { id?: string } | null)?.id;
    if (!id) throw new Error(`Could not resolve machine id for ${appName}`);
    this.machineId = id;
    return id;
  }

  protected override async providerCreate(opts: FlyDeploymentOpts) {
    if (!opts.flyImage) throw new Error("flyImage is required");
    if (!opts.flyApiToken) throw new Error("flyApiToken is required");
    if (!opts.flyBaseDomain) throw new Error("flyBaseDomain is required");

    this.flyBaseDomain = opts.flyBaseDomain;
    this.sandboxMachineName = opts.flyMachineName ?? DEFAULT_FLY_MACHINE_NAME;
    this.api = createClient<paths>({
      baseUrl: opts.flyApiBaseUrl ?? "https://api.machines.dev/v1",
      headers: { Accept: "application/json", Authorization: `Bearer ${opts.flyApiToken}` },
    });

    const appName = normalizeFlyAppName(opts.name);
    this.appName = appName;
    this.machineId = undefined;
    const baseUrl = `https://${appName}.${this.flyBaseDomain}`;

    try {
      console.log(`[fly] creating app ${appName}...`);
      await this.ensureApp(appName, opts);
      await this.ensureIPs(appName, opts);
      const machineId = await this.createMachine(appName, opts);
      this.machineId = machineId;
      await this.waitForMachineState({ appName, machineId, state: "started" });
      console.log(`[fly] machine ${machineId} started`);
    } catch (error) {
      const logs = await this.providerExec(["sh", "-ec", PIDNAP_LOG_TAIL_CMD]).catch((e) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`,
      }));
      await this.deleteFlyResources().catch(() => {});
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${logs.output}`,
        { cause: error },
      );
    }

    return { locator: { provider: "fly" as const, appName, machineId: this.machineId }, baseUrl };
  }

  protected override async providerDispose(): Promise<void> {
    await this.deleteFlyResources();
  }

  protected override async providerExec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    const appName = this.requireAppName();
    const machineId = await this.resolveMachineId();
    const command = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;
    const result = await this.flyCall({
      method: "POST",
      path: "/apps/{app_name}/machines/{machine_id}/exec",
      call: async () =>
        await this.requireApi().POST("/apps/{app_name}/machines/{machine_id}/exec", {
          params: this.machinePath(appName, machineId),
          body: { command, timeout: 120 },
        }),
    });
    const r = result as { exit_code?: number; stdout?: string; stderr?: string };
    return { exitCode: r.exit_code ?? 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  protected override async providerLogs(): Promise<string> {
    return (
      await this.providerExec(["sh", "-ec", PIDNAP_LOG_TAIL_CMD]).catch((e) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`,
      }))
    ).output;
  }

  private async ensureApp(appName: string, opts: FlyDeploymentOpts): Promise<void> {
    try {
      await this.flyCall({
        method: "POST",
        path: "/apps",
        call: async () =>
          await this.requireApi().POST("/apps", {
            body: {
              name: appName,
              org_slug: opts.flyOrgSlug ?? DEFAULT_FLY_ORG_SLUG,
              ...(opts.flyNetwork ? { network: opts.flyNetwork } : {}),
            },
          }),
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }

  private async ensureIPs(appName: string, opts: FlyDeploymentOpts): Promise<void> {
    for (const ipType of ["v6", "shared_v4"] as const) {
      try {
        await this.flyCall({
          method: "POST",
          path: "/apps/{app_name}/ip_assignments",
          call: async () =>
            await this.requireApi().POST("/apps/{app_name}/ip_assignments", {
              params: this.appPath(appName),
              body: {
                type: ipType,
                org_slug: opts.flyOrgSlug ?? DEFAULT_FLY_ORG_SLUG,
                ...(opts.flyNetwork ? { network: opts.flyNetwork } : {}),
              },
            }),
        });
      } catch (error) {
        if (!isAlreadyExistsError(error) && !isIpAlreadyAllocatedError(error)) throw error;
      }
    }
  }

  private async createMachine(appName: string, opts: FlyDeploymentOpts): Promise<string> {
    const envRecord = toEnvRecord(opts.env);
    const body: FlyCreateMachineRequest = {
      name: this.sandboxMachineName,
      region: opts.flyRegion ?? DEFAULT_FLY_REGION,
      skip_launch: false,
      config: {
        image: opts.flyImage,
        env: {
          ...envRecord,
          ITERATE_PUBLIC_BASE_URL:
            envRecord.ITERATE_PUBLIC_BASE_URL ?? `https://${appName}.${this.flyBaseDomain}`,
          ITERATE_PUBLIC_BASE_URL_TYPE: envRecord.ITERATE_PUBLIC_BASE_URL_TYPE ?? "prefix",
        },
        guest: {
          cpu_kind: "shared",
          cpus: opts.flyMachineCpus ?? DEFAULT_FLY_MACHINE_CPUS,
          memory_mb: opts.flyMachineMemoryMb ?? DEFAULT_FLY_MACHINE_MEMORY_MB,
        },
        restart: { policy: "always" },
        services: [
          {
            protocol: "tcp",
            internal_port: opts.flyInternalPort ?? DEFAULT_FLY_INTERNAL_PORT,
            ports: [
              { port: 80, handlers: ["http"] },
              { port: 443, handlers: ["tls", "http"] },
            ],
          },
        ],
        metadata: {
          "com.iterate.sandbox": "true",
          "com.iterate.machine_type": "fly",
          "com.iterate.external_id": appName,
        },
      },
    };
    const created = await this.flyCall({
      method: "POST",
      path: "/apps/{app_name}/machines",
      call: async () =>
        await this.requireApi().POST("/apps/{app_name}/machines", {
          params: this.appPath(appName),
          body,
        }),
    });
    const machineId = (created as { id?: string }).id;
    if (!machineId) throw new Error(`Fly machine creation returned no id for ${appName}`);
    return machineId;
  }

  private async waitForMachineState(params: {
    appName: string;
    machineId: string;
    state: "started" | "stopped" | "suspended" | "destroyed";
    timeoutSeconds?: number;
  }): Promise<void> {
    const timeout = params.timeoutSeconds ?? FLY_WAIT_TIMEOUT_SECONDS;
    const start = Date.now();
    while (true) {
      const remaining = timeout - Math.floor((Date.now() - start) / 1000);
      if (remaining <= 0)
        throw new Error(`timed out waiting for machine ${params.machineId} state=${params.state}`);
      const step = Math.max(1, Math.min(remaining, FLY_MAX_WAIT_STEP_SECONDS));
      try {
        await this.flyCall({
          method: "GET",
          path: "/apps/{app_name}/machines/{machine_id}/wait",
          call: async () =>
            await this.requireApi().GET("/apps/{app_name}/machines/{machine_id}/wait", {
              params: {
                ...this.machinePath(params.appName, params.machineId),
                query: { state: params.state, timeout: step },
              },
            }),
        });
        return;
      } catch (error) {
        if (!isWaitTimeoutError(error)) throw error;
      }
    }
  }

  private async deleteFlyResources(): Promise<void> {
    const appName = this.appName;
    if (!appName) return;
    const machineId = this.machineId ?? (await this.resolveMachineId().catch(() => undefined));
    if (machineId) {
      await this.flyCall({
        method: "DELETE",
        path: "/apps/{app_name}/machines/{machine_id}",
        call: async () =>
          await this.requireApi().DELETE("/apps/{app_name}/machines/{machine_id}", {
            params: { ...this.machinePath(appName, machineId), query: { force: true } },
          }),
      }).catch((e) => {
        if (!isNotFoundError(e)) throw e;
      });
    }
    await this.flyCall({
      method: "DELETE",
      path: "/apps/{app_name}",
      call: async () =>
        await this.requireApi().DELETE("/apps/{app_name}", { params: this.appPath(appName) }),
      retry: {
        retries: 8,
        minTimeout: 500,
        maxTimeout: 3_000,
        shouldRetry: (e) => isRetriableNetworkError(e) || isMachineStillActiveError(e),
      },
    }).catch((e) => {
      if (!isNotFoundError(e)) throw e;
    });
  }

  static async create(opts: FlyDeploymentOpts): Promise<FlyDeployment> {
    const deployment = new FlyDeployment();
    await deployment.create(opts);
    return deployment;
  }
}
