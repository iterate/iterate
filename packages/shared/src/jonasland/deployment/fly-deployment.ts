import { randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import {
  Deployment,
  PIDNAP_LOG_TAIL_CMD,
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
  private api: Client<paths> | null = null;
  private flyBaseDomain = "";
  private appName: string | null = null;
  private machineId: string | undefined;
  private sandboxMachineName = "sandbox";

  private requireApi(): Client<paths> {
    if (!this.api) throw new Error("fly api not initialized");
    return this.api;
  }

  private requireAppName(): string {
    if (!this.appName) throw new Error("fly app not initialized");
    return this.appName;
  }

  private async flyCall<TData>(
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

  private async resolveMachineId(): Promise<string> {
    if (this.machineId) return this.machineId;
    const appName = this.requireAppName();
    const machines = await this.flyCall("GET", "/apps/{app_name}/machines", async () =>
      this.requireApi().GET("/apps/{app_name}/machines", {
        params: { path: { app_name: appName } },
      }),
    );
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

  override async create(opts: FlyDeploymentOpts): Promise<FlyDeploymentLocator> {
    if (this.state !== "new") {
      throw new Error(`${this.constructor.name} is in state "${this.state}", expected "new"`);
    }
    console.log(`[deployment] creating ${this.constructor.name}...`);
    throwIfAborted(opts.signal);
    if (!opts.flyImage) throw new Error("flyImage is required");
    if (!opts.flyApiToken) throw new Error("flyApiToken is required");
    if (!opts.flyBaseDomain) throw new Error("flyBaseDomain is required");

    this.flyBaseDomain = opts.flyBaseDomain;
    this.sandboxMachineName = opts.flyMachineName ?? "sandbox";
    this.api = createClient<paths>({
      baseUrl: opts.flyApiBaseUrl ?? "https://api.machines.dev/v1",
      headers: { Accept: "application/json", Authorization: `Bearer ${opts.flyApiToken}` },
    });

    const appName = normalizeFlyAppName(opts.name);
    this.appName = appName;
    this.machineId = undefined;
    const orgSlug = opts.flyOrgSlug ?? "iterate";

    try {
      console.log(`[fly] creating app ${appName}...`);

      await this.flyCall("POST", "/apps", async () =>
        this.requireApi().POST("/apps", {
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
        await this.flyCall("POST", "/apps/{app_name}/ip_assignments", async () =>
          this.requireApi().POST("/apps/{app_name}/ip_assignments", {
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
      const created = await this.flyCall("POST", "/apps/{app_name}/machines", async () =>
        this.requireApi().POST("/apps/{app_name}/machines", {
          params: { path: { app_name: appName } },
          body: {
            name: this.sandboxMachineName,
            region: opts.flyRegion ?? "lhr",
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
      const machineId = (created as { id?: string }).id;
      if (!machineId) throw new Error(`Fly machine creation returned no id for ${appName}`);
      this.machineId = machineId;

      await this.waitForMachineState(appName, machineId, "started", 300, opts.signal);
      console.log(`[fly] machine ${machineId} started`);
    } catch (error) {
      const logs = await this.execOnMachine(PIDNAP_LOG_TAIL_CMD).catch((e) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`,
      }));
      await this.deleteFlyResources().catch(() => {});
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${logs.output}`,
        { cause: error },
      );
    }

    const locator = { provider: "fly" as const, appName, machineId: this.machineId };
    this.baseUrl = `https://${appName}.${this.flyBaseDomain}`;
    this.locator = locator;
    this.state = "running";
    console.log(`[deployment] created, baseUrl=${this.baseUrl}`);
    return locator;
  }

  override async exec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    this.assertRunning();
    return await this.execOnMachine(cmd);
  }

  override async logs(): Promise<string> {
    this.assertRunning();
    return (
      await this.execOnMachine(PIDNAP_LOG_TAIL_CMD).catch((e) => ({
        exitCode: 1,
        output: `failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`,
      }))
    ).output;
  }

  protected override async dispose(): Promise<void> {
    await this.deleteFlyResources();
  }

  private async execOnMachine(cmd: string | string[]): Promise<DeploymentCommandResult> {
    const appName = this.requireAppName();
    const machineId = await this.resolveMachineId();
    const command = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;
    const result = await this.flyCall(
      "POST",
      "/apps/{app_name}/machines/{machine_id}/exec",
      async () =>
        this.requireApi().POST("/apps/{app_name}/machines/{machine_id}/exec", {
          params: { path: { app_name: appName, machine_id: machineId } },
          body: { command, timeout: 120 },
        }),
    );
    const r = result as { exit_code?: number; stdout?: string; stderr?: string };
    return { exitCode: r.exit_code ?? 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  private async waitForMachineState(
    appName: string,
    machineId: string,
    state: "started" | "stopped" | "suspended" | "destroyed",
    timeoutSeconds = 300,
    signal?: AbortSignal,
  ): Promise<void> {
    const start = Date.now();
    while (true) {
      throwIfAborted(signal);
      const remaining = timeoutSeconds - Math.floor((Date.now() - start) / 1000);
      if (remaining <= 0)
        throw new Error(`timed out waiting for machine ${machineId} state=${state}`);
      const step = Math.max(1, Math.min(remaining, 60));
      try {
        await this.flyCall("GET", "/apps/{app_name}/machines/{machine_id}/wait", async () =>
          this.requireApi().GET("/apps/{app_name}/machines/{machine_id}/wait", {
            params: {
              path: { app_name: appName, machine_id: machineId },
              query: { state, timeout: step },
            },
          }),
        );
        return;
      } catch (error) {
        if (!matchesError(error, "deadline_exceeded", "(408)", "timeout")) throw error;
      }
    }
  }

  private async deleteFlyResources(): Promise<void> {
    const appName = this.appName;
    if (!appName) return;
    const machineId = this.machineId ?? (await this.resolveMachineId().catch(() => undefined));
    if (machineId) {
      await this.flyCall("DELETE", "/apps/{app_name}/machines/{machine_id}", async () =>
        this.requireApi().DELETE("/apps/{app_name}/machines/{machine_id}", {
          params: { path: { app_name: appName, machine_id: machineId }, query: { force: true } },
        }),
      ).catch((e) => {
        if (!matchesError(e, "not found", "(404)")) throw e;
      });
    }
    await this.flyCall("DELETE", "/apps/{app_name}", async () =>
      this.requireApi().DELETE("/apps/{app_name}", {
        params: { path: { app_name: appName } },
      }),
    ).catch((e) => {
      if (!matchesError(e, "not found", "(404)")) throw e;
    });
  }

  static async create(opts: FlyDeploymentOpts): Promise<FlyDeployment> {
    const deployment = new FlyDeployment();
    await deployment.create(opts);
    return deployment;
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
