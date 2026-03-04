import { randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import {
  Deployment,
  PIDNAP_LOG_TAIL_CMD,
  type DeploymentProvider,
  type DeploymentProviderStatus,
  type ProvisionResult,
  throwIfAborted,
  type DeploymentCommandResult,
  type DeploymentOpts,
} from "./deployment.ts";
import { toEnvRecord } from "./deployment-utils.ts";
import type { components, paths } from "./fly-api/generated/openapi.gen.ts";

export interface FlyDeploymentLocator {
  provider: "fly";
  appName: string;
  machineId?: string;
}

export interface FlyDeploymentOpts extends DeploymentOpts {
  flyImage?: string;
  flyApiToken?: string;
  flyApiBaseUrl?: string;
  flyOrgSlug?: string;
  flyNetwork?: string;
  flyRegion?: string;
  flyMachineCpus?: number;
  flyMachineMemoryMb?: number;
  flyInternalPort?: number;
  flyMachineName?: string;
}

const FLY_BASE_DOMAIN = "fly.dev";

class FlyProvider implements DeploymentProvider<FlyDeploymentOpts, FlyDeploymentLocator> {
  async create(opts: FlyDeploymentOpts): Promise<ProvisionResult<FlyDeploymentLocator>> {
    if (!opts.flyImage) throw new Error("flyImage is required");
    const api = createFlyApi(opts);
    const appName = normalizeFlyAppName(opts.name);
    const orgSlug = opts.flyOrgSlug ?? "iterate";
    const sandboxMachineName = opts.flyMachineName ?? "sandbox";
    let machineId: string | undefined;

    try {
      console.log(`[fly] creating app ${appName}...`);
      await flyCall(api, "POST", "/apps", async () =>
        api.POST("/apps", {
          body: {
            name: appName,
            org_slug: orgSlug,
            ...(opts.flyNetwork ? { network: opts.flyNetwork } : {}),
          },
        }),
      ).catch((e) => {
        if (!matchesError(e, "already exists", "already been taken")) throw e;
      });

      for (const type of ["v6", "shared_v4"] as const) {
        throwIfAborted(opts.signal);
        await flyCall(api, "POST", "/apps/{app_name}/ip_assignments", async () =>
          api.POST("/apps/{app_name}/ip_assignments", {
            params: { path: { app_name: appName } },
            body: {
              type,
              org_slug: orgSlug,
              ...(opts.flyNetwork ? { network: opts.flyNetwork } : {}),
            },
          }),
        ).catch((e) => {
          if (!matchesError(e, "already exists", "already been taken", "already has")) throw e;
        });
      }

      const envRecord = toEnvRecord(opts.env);
      throwIfAborted(opts.signal);
      const created = await flyCall(api, "POST", "/apps/{app_name}/machines", async () =>
        api.POST("/apps/{app_name}/machines", {
          params: { path: { app_name: appName } },
          body: {
            name: sandboxMachineName,
            region: opts.flyRegion ?? "lhr",
            skip_launch: false,
            config: {
              image: opts.flyImage,
              env: {
                ...envRecord,
                ITERATE_PUBLIC_BASE_URL:
                  envRecord.ITERATE_PUBLIC_BASE_URL ?? `https://${appName}.${FLY_BASE_DOMAIN}`,
                ITERATE_PUBLIC_BASE_URL_TYPE: envRecord.ITERATE_PUBLIC_BASE_URL_TYPE ?? "prefix",
              },
              guest: {
                cpu_kind: "shared",
                cpus: opts.flyMachineCpus ?? 4,
                memory_mb: opts.flyMachineMemoryMb ?? 4096,
              },
              restart: { policy: "always" },
              services: [
                {
                  protocol: "tcp",
                  internal_port: opts.flyInternalPort ?? 8080,
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
          } satisfies components["schemas"]["CreateMachineRequest"],
        }),
      );
      machineId = (created as { id?: string }).id;
      if (!machineId) throw new Error(`Fly machine creation returned no id for ${appName}`);

      await waitForMachineState({
        api,
        appName,
        machineId,
        state: "started",
        timeoutSeconds: 300,
        signal: opts.signal,
      });
      console.log(`[fly] machine ${machineId} started`);
    } catch (error) {
      const logs = await execOnMachine({
        opts,
        appName,
        machineId,
        cmd: PIDNAP_LOG_TAIL_CMD,
      }).catch((e) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`,
      }));
      await deleteFlyResources({
        opts,
        appName,
        machineId,
        sandboxMachineName,
      }).catch(() => {});
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${logs.output}`,
        { cause: error },
      );
    }

    return {
      locator: {
        provider: "fly",
        appName,
        machineId,
      },
      baseUrl: `https://${appName}.${FLY_BASE_DOMAIN}`,
    };
  }

  async destroy(params: { locator: FlyDeploymentLocator; opts: FlyDeploymentOpts }): Promise<void> {
    await deleteFlyResources({
      opts: params.opts,
      appName: params.locator.appName,
      machineId: params.locator.machineId,
      sandboxMachineName: params.opts.flyMachineName ?? "sandbox",
    });
  }

  async exec(params: {
    locator: FlyDeploymentLocator;
    opts: FlyDeploymentOpts;
    cmd: string | string[];
  }): Promise<DeploymentCommandResult> {
    return await execOnMachine({
      opts: params.opts,
      appName: params.locator.appName,
      machineId: params.locator.machineId,
      cmd: params.cmd,
    });
  }

  async logs(params: { locator: FlyDeploymentLocator; opts: FlyDeploymentOpts }): Promise<string> {
    return (
      await execOnMachine({
        opts: params.opts,
        appName: params.locator.appName,
        machineId: params.locator.machineId,
        cmd: PIDNAP_LOG_TAIL_CMD,
      }).catch((e) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`,
      }))
    ).output;
  }

  async status(params: {
    locator: FlyDeploymentLocator;
    opts: FlyDeploymentOpts;
  }): Promise<DeploymentProviderStatus> {
    const api = createFlyApi(params.opts);
    const machineId =
      params.locator.machineId ??
      (await resolveMachineId({
        api,
        appName: params.locator.appName,
        machineName: params.opts.flyMachineName ?? "sandbox",
      }));
    const machine = await flyCall(api, "GET", "/apps/{app_name}/machines/{machine_id}", async () =>
      api.GET("/apps/{app_name}/machines/{machine_id}", {
        params: { path: { app_name: params.locator.appName, machine_id: machineId } },
      }),
    );
    const raw = ((machine as { state?: string }).state ?? "unknown").toLowerCase();
    return {
      state: mapFlyMachineState(raw),
      detail: `fly state=${raw} app=${params.locator.appName} machine=${machineId}`,
    };
  }
}

export class FlyDeployment extends Deployment<FlyDeploymentOpts, FlyDeploymentLocator> {
  constructor() {
    super(new FlyProvider());
  }

  static async create(opts: FlyDeploymentOpts): Promise<FlyDeployment> {
    const deployment = new FlyDeployment();
    await deployment.create(opts);
    return deployment;
  }
}

function createFlyApi(opts: FlyDeploymentOpts): Client<paths> {
  if (!opts.flyApiToken) throw new Error("flyApiToken is required");
  return createClient<paths>({
    baseUrl: opts.flyApiBaseUrl ?? "https://api.machines.dev/v1",
    headers: { Accept: "application/json", Authorization: `Bearer ${opts.flyApiToken}` },
  });
}

async function flyCall<TData>(
  api: Client<paths>,
  method: string,
  path: string,
  call: () => Promise<{ data?: TData; error?: unknown; response: Response }>,
): Promise<TData> {
  const { data, error, response } = await call();
  if (error) {
    const details = (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    })();
    throw new Error(`Fly API (${response.status}) ${method} ${path}: ${details}`);
  }
  return data as TData;
}

async function resolveMachineId(params: {
  api: Client<paths>;
  appName: string;
  machineName: string;
}): Promise<string> {
  const machines = await flyCall(params.api, "GET", "/apps/{app_name}/machines", async () =>
    params.api.GET("/apps/{app_name}/machines", {
      params: { path: { app_name: params.appName } },
    }),
  );
  if (!Array.isArray(machines)) throw new Error(`Could not list machines for ${params.appName}`);
  const match =
    machines.find((m: { name?: string }) => m.name === params.machineName) ??
    machines.find(
      (m: { config?: { metadata?: Record<string, string | undefined> } }) =>
        m.config?.metadata?.["com.iterate.sandbox"] === "true",
    ) ??
    (machines.length === 1 ? machines[0] : null);
  const id = (match as { id?: string } | null)?.id;
  if (!id) throw new Error(`Could not resolve machine id for ${params.appName}`);
  return id;
}

async function waitForMachineState(params: {
  api: Client<paths>;
  appName: string;
  machineId: string;
  state: "started" | "stopped" | "suspended" | "destroyed";
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const timeoutSeconds = params.timeoutSeconds ?? 300;
  const start = Date.now();
  while (true) {
    throwIfAborted(params.signal);
    const remaining = timeoutSeconds - Math.floor((Date.now() - start) / 1000);
    if (remaining <= 0) {
      throw new Error(`timed out waiting for machine ${params.machineId} state=${params.state}`);
    }
    const step = Math.max(1, Math.min(remaining, 60));
    try {
      await flyCall(params.api, "GET", "/apps/{app_name}/machines/{machine_id}/wait", async () =>
        params.api.GET("/apps/{app_name}/machines/{machine_id}/wait", {
          params: {
            path: { app_name: params.appName, machine_id: params.machineId },
            query: { state: params.state, timeout: step },
          },
        }),
      );
      return;
    } catch (error) {
      if (!matchesError(error, "deadline_exceeded", "(408)", "timeout")) throw error;
    }
  }
}

async function execOnMachine(params: {
  opts: FlyDeploymentOpts;
  appName: string;
  machineId?: string;
  cmd: string | string[];
}): Promise<DeploymentCommandResult> {
  const api = createFlyApi(params.opts);
  const machineId =
    params.machineId ??
    (await resolveMachineId({
      api,
      appName: params.appName,
      machineName: params.opts.flyMachineName ?? "sandbox",
    }));
  const command = typeof params.cmd === "string" ? ["sh", "-ec", params.cmd] : params.cmd;
  const result = await flyCall(
    api,
    "POST",
    "/apps/{app_name}/machines/{machine_id}/exec",
    async () =>
      api.POST("/apps/{app_name}/machines/{machine_id}/exec", {
        params: { path: { app_name: params.appName, machine_id: machineId } },
        body: { command, timeout: 120 },
      }),
  );
  const r = result as { exit_code?: number; stdout?: string; stderr?: string };
  return { exitCode: r.exit_code ?? 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function deleteFlyResources(params: {
  opts: FlyDeploymentOpts;
  appName: string;
  machineId?: string;
  sandboxMachineName: string;
}): Promise<void> {
  const api = createFlyApi(params.opts);
  const machineId =
    params.machineId ??
    (await resolveMachineId({
      api,
      appName: params.appName,
      machineName: params.sandboxMachineName,
    }).catch(() => undefined));
  if (machineId) {
    await flyCall(api, "DELETE", "/apps/{app_name}/machines/{machine_id}", async () =>
      api.DELETE("/apps/{app_name}/machines/{machine_id}", {
        params: {
          path: { app_name: params.appName, machine_id: machineId },
          query: { force: true },
        },
      }),
    ).catch((e) => {
      if (!matchesError(e, "not found", "(404)")) throw e;
    });
  }
  await flyCall(api, "DELETE", "/apps/{app_name}", async () =>
    api.DELETE("/apps/{app_name}", {
      params: { path: { app_name: params.appName } },
    }),
  ).catch((e) => {
    if (!matchesError(e, "not found", "(404)")) throw e;
  });
}

function mapFlyMachineState(raw: string): DeploymentProviderStatus["state"] {
  switch (raw) {
    case "started":
    case "starting":
      return "running";
    case "created":
      return "starting";
    case "stopped":
    case "suspended":
      return "stopped";
    case "destroyed":
      return "destroyed";
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}

function normalizeFlyAppName(value?: string): string {
  const raw = value ?? `jonasland-e2e-fly-${randomUUID().slice(0, 8)}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

function matchesError(error: unknown, ...patterns: string[]): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return patterns.some((p) => msg.includes(p));
}
