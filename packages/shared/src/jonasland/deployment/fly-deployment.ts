import createClient, { type Client } from "openapi-fetch";
import {
  type DeploymentProviderState,
  type DeploymentProvider,
} from "./deployment-provider-manifest.ts";
import { throwIfAborted, toEnvRecord } from "./deployment-utils.ts";
import {
  flyProviderManifest,
  type FlyDeploymentLocator,
  type FlyDeploymentOpts,
  type FlyProviderOpts,
} from "./fly-deployment-manifest.ts";
import type { components, paths } from "./fly-api/generated/openapi.gen.ts";
export {
  flyDeploymentLocatorSchema,
  flyDeploymentOptsSchema,
  flyProviderManifest,
  flyProviderOptsSchema,
} from "./fly-deployment-manifest.ts";
export type {
  FlyDeploymentLocator,
  FlyDeploymentOpts,
  FlyProviderOpts,
} from "./fly-deployment-manifest.ts";

const FLY_BASE_DOMAIN = "fly.dev";
// We persist effective deployment opts on the Fly machine metadata so reconnect
// can recover them from Fly alone, without an external opts store.
const FLY_RUNTIME_METADATA_KEY = "com.iterate.instance-specific-opts";
export function createFlyProvider(
  providerOpts: FlyProviderOpts,
): DeploymentProvider<FlyDeploymentOpts, FlyDeploymentLocator, FlyProviderOpts> {
  return {
    ...flyProviderManifest,
    async create(params) {
      const opts = withDefaultFlyOpts(params.opts);
      if (!opts.image) throw new Error("image is required");
      const api = createFlyApi(providerOpts);
      const appName = opts.slug;
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
        ).catch((error) => {
          if (!matchesError(error, "already exists", "already been taken")) throw error;
        });

        for (const type of ["v6", "shared_v4"] as const) {
          throwIfAborted(params.signal);
          await flyCall(api, "POST", "/apps/{app_name}/ip_assignments", async () =>
            api.POST("/apps/{app_name}/ip_assignments", {
              params: { path: { app_name: appName } },
              body: {
                type,
                org_slug: orgSlug,
                ...(opts.flyNetwork ? { network: opts.flyNetwork } : {}),
              },
            }),
          ).catch((error) => {
            if (!matchesError(error, "already exists", "already been taken", "already has")) {
              throw error;
            }
          });
        }

        const envRecord = toEnvRecord(opts.env);
        const machineInit = resolveFlyMachineInit(opts);
        throwIfAborted(params.signal);
        await flyCall(api, "POST", "/apps/{app_name}/machines", async () =>
          api.POST("/apps/{app_name}/machines", {
            params: { path: { app_name: appName } },
            body: {
              name: sandboxMachineName,
              region: opts.flyRegion ?? "lhr",
              skip_launch: false,
              config: {
                image: opts.image,
                ...(machineInit ? { init: machineInit } : {}),
                env: {
                  ...envRecord,
                  ITERATE_INGRESS_HOST:
                    envRecord.ITERATE_INGRESS_HOST ?? `${appName}.${FLY_BASE_DOMAIN}`,
                  ITERATE_INGRESS_ROUTING_TYPE:
                    envRecord.ITERATE_INGRESS_ROUTING_TYPE ?? "subdomain-host",
                },
                guest: {
                  cpu_kind: "shared",
                  cpus: opts.flyMachineCpus ?? 4,
                  memory_mb: opts.flyMachineMemoryMb ?? 4096,
                },
                // Fly's rootfs persistence is restart convenience, not durable
                // storage. It may still be wiped for maintenance or recovery.
                rootfs: {
                  persist: opts.rootfsSurvivesRestart ? "restart" : "never",
                },
                restart: { policy: "always" },
                services: [
                  {
                    protocol: "tcp",
                    internal_port: 80,
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
                  [FLY_RUNTIME_METADATA_KEY]: serializeFlyRuntimeMetadata(opts),
                },
              },
            } satisfies components["schemas"]["CreateMachineRequest"],
          }),
        );
        machineId = await waitForMachineDiscovery({
          api,
          appName,
          machineName: sandboxMachineName,
          timeoutMs: 60_000,
          signal: params.signal,
        });
        machineId = await waitForMachineState({
          api,
          appName,
          machineId,
          machineName: sandboxMachineName,
          state: "started",
          timeoutSeconds: 300,
          signal: params.signal,
        });
        console.log(`[fly] machine ${machineId} started`);
      } catch (error) {
        const logs = await collectFlyAppLogs({
          providerOpts,
          appName,
          machineId,
          tailLines: 200,
          signal: params.signal,
        }).catch(
          (innerError) =>
            `failed to fetch logs: ${
              innerError instanceof Error ? innerError.message : String(innerError)
            }`,
        );
        await deleteFlyResources({
          providerOpts,
          appName,
          machineId,
          sandboxMachineName,
        }).catch(() => {});
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nbootstrap logs:\n${logs}`,
          { cause: error },
        );
      }

      return {
        locator: {
          provider: "fly",
          appName,
          machineId,
        },
        baseUrl: `http://${appName}.${FLY_BASE_DOMAIN}`,
      };
    },
    async connect(params) {
      const locator = toFlyLocator(params.locator);
      const api = createFlyApi(providerOpts);
      const machineId =
        locator.machineId ??
        (await resolveMachineId({
          api,
          appName: locator.appName,
          machineName: "sandbox",
        }).catch(() => undefined));

      return {
        locator: {
          ...locator,
          ...(machineId ? { machineId } : {}),
        },
        baseUrl: `http://${locator.appName}.${FLY_BASE_DOMAIN}`,
      };
    },
    async recoverOpts(params) {
      const locator = toFlyLocator(params.locator);
      const api = createFlyApi(providerOpts);
      const machineId =
        locator.machineId ??
        (await resolveMachineId({
          api,
          appName: locator.appName,
          machineName: "sandbox",
        }));
      const machine = await flyCall(
        api,
        "GET",
        "/apps/{app_name}/machines/{machine_id}",
        async () =>
          api.GET("/apps/{app_name}/machines/{machine_id}", {
            params: { path: { app_name: locator.appName, machine_id: machineId } },
          }),
      );
      const machineRecord = machine as {
        name?: string;
        region?: string;
        config?: {
          image?: string;
          init?: components["schemas"]["fly.MachineInit"];
          guest?: { cpus?: number; memory_mb?: number };
          metadata?: Record<string, string | undefined>;
        };
      };
      const metadata = parseFlyRuntimeMetadata(
        machineRecord.config?.metadata?.[FLY_RUNTIME_METADATA_KEY],
      );
      return {
        ...metadata,
        ...(machineRecord.config?.image ? { image: machineRecord.config.image } : {}),
        ...(machineRecord.config?.init?.cmd ? { cmd: machineRecord.config.init.cmd } : {}),
        ...(machineRecord.config?.init?.entrypoint
          ? { entrypoint: machineRecord.config.init.entrypoint }
          : {}),
        ...(machineRecord.region ? { flyRegion: machineRecord.region } : {}),
        ...(machineRecord.name ? { flyMachineName: machineRecord.name } : {}),
        ...(typeof machineRecord.config?.guest?.cpus === "number"
          ? { flyMachineCpus: machineRecord.config.guest.cpus }
          : {}),
        ...(typeof machineRecord.config?.guest?.memory_mb === "number"
          ? { flyMachineMemoryMb: machineRecord.config.guest.memory_mb }
          : {}),
      };
    },
    async destroy(params) {
      const locator = toFlyLocator(params.locator);
      await deleteFlyResources({
        providerOpts,
        appName: locator.appName,
        machineId: locator.machineId,
        sandboxMachineName: "sandbox",
      });
    },
    async start(params) {
      const locator = toFlyLocator(params.locator);
      const api = createFlyApi(providerOpts);
      const machineId =
        locator.machineId ??
        (await resolveMachineId({
          api,
          appName: locator.appName,
          machineName: "sandbox",
        }));
      await flyCall(api, "POST", "/apps/{app_name}/machines/{machine_id}/start", async () =>
        api.POST("/apps/{app_name}/machines/{machine_id}/start", {
          params: { path: { app_name: locator.appName, machine_id: machineId } },
        }),
      );
      await waitForMachineState({
        api,
        appName: locator.appName,
        machineId,
        machineName: "sandbox",
        state: "started",
      });
    },
    async stop(params) {
      const locator = toFlyLocator(params.locator);
      const api = createFlyApi(providerOpts);
      const machineId =
        locator.machineId ??
        (await resolveMachineId({
          api,
          appName: locator.appName,
          machineName: "sandbox",
        }));
      await flyCall(api, "POST", "/apps/{app_name}/machines/{machine_id}/stop", async () =>
        api.POST("/apps/{app_name}/machines/{machine_id}/stop", {
          params: { path: { app_name: locator.appName, machine_id: machineId } },
        }),
      );
      await waitForMachineState({
        api,
        appName: locator.appName,
        machineId,
        machineName: "sandbox",
        state: "stopped",
      });
    },
    async exec(params) {
      const locator = toFlyLocator(params.locator);
      return await execOnMachine({
        providerOpts,
        appName: locator.appName,
        machineId: locator.machineId,
        cmd: params.cmd,
      });
    },
    async *logs(params) {
      throwIfAborted(params.signal);
      const locator = toFlyLocator(params.locator);
      yield* streamFlyAppLogs({
        providerOpts,
        appName: locator.appName,
        machineId: locator.machineId,
        tailLines: params.tail ?? 200,
        signal: params.signal,
      });
    },
    async status(params) {
      const locator = toFlyLocator(params.locator);
      const api = createFlyApi(providerOpts);
      const machineId =
        locator.machineId ??
        (await resolveMachineId({
          api,
          appName: locator.appName,
          machineName: "sandbox",
        }));
      const machine = await flyCall(
        api,
        "GET",
        "/apps/{app_name}/machines/{machine_id}",
        async () =>
          api.GET("/apps/{app_name}/machines/{machine_id}", {
            params: { path: { app_name: locator.appName, machine_id: machineId } },
          }),
      );
      const raw = ((machine as { state?: string }).state ?? "unknown").toLowerCase();
      return {
        state: mapFlyMachineState(raw),
        detail: `fly state=${raw} app=${locator.appName} machine=${machineId}`,
      };
    },
  };
}

/**
 * Creates an openapi-fetch client for the Fly Machines API.
 *
 * Uses `flyAuthorizationHeader()` rather than a hardcoded `Bearer` prefix
 * because tokens in Doppler may already include a scheme prefix, and the
 * Machines API accepts both `FlyV1` and `Bearer` so using the correct
 * scheme for the token type is always safe.
 */
function createFlyApi(opts: FlyProviderOpts): Client<paths> {
  if (!opts.flyApiToken) throw new Error("flyApiToken is required");
  return createClient<paths>({
    baseUrl: opts.flyApiBaseUrl ?? "https://api.machines.dev/v1",
    headers: {
      Accept: "application/json",
      Authorization: flyAuthorizationHeader(opts.flyApiToken),
    },
  });
}

function createFlyAppLogsUrl(params: {
  appName: string;
  machineId?: string;
  tailLines?: number;
  startTime?: string;
}) {
  // This endpoint is separate from the Machines API (`api.machines.dev`).
  // It lives on `api.fly.io` and returns app-level stdout/stderr — the
  // same output you see from `fly logs` in the CLI.
  //
  // It is NOT part of the OpenAPI Machines spec we generate types from.
  // The endpoint is undocumented but stable (flyctl depends on it).
  //
  // Response format: newline-delimited JSON objects, each with:
  //   { "id": "...", "attributes": { "timestamp", "message", "level", "region", "instance", "meta" } }
  // wrapped in { "data": [...], "meta": { "next_token": "..." } }.
  //
  // Auth: must use `flyAuthorizationHeader()` — see that function's
  // docstring for the full explanation of why `FlyV1` is required.
  //
  // Important: Fly's own docs say the HTTP logs API instance filter is
  // "sometimes flaky". These deployment apps are single-machine, so prefer
  // app-level log tailing over filtering by machine ID for better reliability:
  // https://fly.io/docs/monitoring/logs-api-options/
  //
  // References:
  //   - https://fly.io/docs/monitoring/logging-overview/
  //   - https://fly.io/docs/monitoring/logs-api-options/
  //   - flyctl source: `superfly/fly-go/resource_logs.go` → `GetAppLogs()`
  //   - flyctl source: `superfly/flyctl/logs/polling.go` → `Poll()`
  const url = new URL(`https://api.fly.io/api/v1/apps/${params.appName}/logs`);
  if (params.startTime) {
    url.searchParams.set("start_time", params.startTime);
  } else if (params.tailLines && params.tailLines > 0) {
    url.searchParams.set("start_time", new Date(Date.now() - 5 * 60_000).toISOString());
  }
  return url;
}

async function collectFlyAppLogs(params: {
  providerOpts: FlyProviderOpts;
  appName: string;
  machineId?: string;
  tailLines: number;
  signal?: AbortSignal;
}) {
  if (!params.providerOpts.flyApiToken) throw new Error("flyApiToken is required for logs");
  const response = await fetch(createFlyAppLogsUrl(params), {
    headers: {
      Authorization: flyAuthorizationHeader(params.providerOpts.flyApiToken),
      Accept: "application/json",
    },
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Fly logs API returned ${String(response.status)}`);
  }
  const text = await response.text();
  return extractFlyLogLines(text).slice(-params.tailLines).join("\n");
}

async function* streamFlyAppLogs(params: {
  providerOpts: FlyProviderOpts;
  appName: string;
  machineId?: string;
  tailLines: number;
  signal: AbortSignal;
}): AsyncIterable<{ line: string; providerData?: Record<string, unknown> }> {
  if (!params.providerOpts.flyApiToken) throw new Error("flyApiToken is required for logs");
  // Fly's HTTP logs API is best suited to quick fetches and simple polling
  // scripts. Poll it with a short overlap window rather than assuming one
  // fetch will behave like a perfect live tail:
  // https://fly.io/docs/monitoring/logs-api-options/
  let cursorMs = Date.now() - 5_000;
  const seen = new Set<string>();

  while (!params.signal.aborted) {
    const response = await fetch(
      createFlyAppLogsUrl({
        ...params,
        startTime: new Date(cursorMs).toISOString(),
      }),
      {
        headers: {
          Authorization: flyAuthorizationHeader(params.providerOpts.flyApiToken),
          Accept: "application/json",
        },
        signal: params.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Fly logs API returned ${String(response.status)}`);
    }
    const text = await response.text();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      for (const payloadLine of parseFlyLogEvents(line)) {
        yield payloadLine;
      }
    }

    cursorMs = Date.now() - 1_000;
    await waitForNextLogPoll(params.signal, 1_000);
  }
}

function extractFlyLogLines(text: string) {
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    for (const event of parseFlyLogEvents(rawLine.trim())) {
      lines.push(event.line);
    }
  }
  return lines;
}

function parseFlyLogEvents(
  rawLine: string,
): Array<{ line: string; providerData?: Record<string, unknown> }> {
  if (!rawLine) return [];
  try {
    const parsed = JSON.parse(rawLine) as {
      data?: Array<{
        id?: string;
        type?: string;
        attributes?: {
          message?: string;
          timestamp?: string;
          level?: string;
          instance?: string;
          region?: string;
          meta?: Record<string, unknown> | null;
        };
      }>;
      message?: string;
      msg?: string;
      event?: { message?: string };
    };
    if (Array.isArray(parsed.data)) {
      return parsed.data.reduce<Array<{ line: string; providerData?: Record<string, unknown> }>>(
        (acc, entry) => {
          const line = entry.attributes?.message;
          if (!line) return acc;
          acc.push({
            line,
            providerData: {
              ...(entry.id ? { id: entry.id } : {}),
              ...(entry.type ? { type: entry.type } : {}),
              ...(entry.attributes?.timestamp ? { timestamp: entry.attributes.timestamp } : {}),
              ...(entry.attributes?.level ? { level: entry.attributes.level } : {}),
              ...(entry.attributes?.instance ? { instance: entry.attributes.instance } : {}),
              ...(entry.attributes?.region ? { region: entry.attributes.region } : {}),
              ...(entry.attributes?.meta ? { meta: entry.attributes.meta } : {}),
            },
          });
          return acc;
        },
        [],
      );
    }
    const single = parsed.message ?? parsed.msg ?? parsed.event?.message;
    return single ? [{ line: single }] : [{ line: rawLine }];
  } catch {
    return [{ line: rawLine }];
  }
}

async function waitForNextLogPoll(signal: AbortSignal, ms: number) {
  if (signal.aborted) {
    throwIfAborted(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function flyCall<TData>(
  _api: Client<paths>,
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

async function waitForMachineDiscovery(params: {
  api: Client<paths>;
  appName: string;
  machineName: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < params.timeoutMs) {
    throwIfAborted(params.signal);
    const machineId = await resolveMachineId({
      api: params.api,
      appName: params.appName,
      machineName: params.machineName,
    }).catch(() => undefined);
    if (machineId) return machineId;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `timed out discovering Fly machine for app=${params.appName} name=${params.machineName}`,
  );
}

async function waitForMachineState(params: {
  api: Client<paths>;
  appName: string;
  machineId: string;
  machineName?: string;
  state: "started" | "stopped" | "suspended" | "destroyed";
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<string> {
  let machineId = params.machineId;
  const timeoutSeconds = params.timeoutSeconds ?? 300;
  const start = Date.now();
  while (true) {
    throwIfAborted(params.signal);
    const remaining = timeoutSeconds - Math.floor((Date.now() - start) / 1000);
    if (remaining <= 0) {
      throw new Error(`timed out waiting for machine ${params.machineId} state=${params.state}`);
    }
    try {
      const machine = await flyCall(
        params.api,
        "GET",
        "/apps/{app_name}/machines/{machine_id}",
        async () =>
          params.api.GET("/apps/{app_name}/machines/{machine_id}", {
            params: {
              path: { app_name: params.appName, machine_id: machineId },
            },
          }),
      );
      const rawState = String((machine as { state?: string }).state ?? "").toLowerCase();
      if (rawState === params.state) {
        return machineId;
      }
      if (
        params.state === "started" &&
        (rawState === "starting" || rawState === "created" || rawState === "")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (params.state !== "started" && rawState === params.state) {
        return machineId;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } catch (error) {
      if (matchesError(error, "not_found", "machine not found") && params.machineName) {
        const resolvedMachineId = await resolveMachineId({
          api: params.api,
          appName: params.appName,
          machineName: params.machineName,
        }).catch(() => undefined);
        if (resolvedMachineId) {
          machineId = resolvedMachineId;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
      }
      if (!matchesError(error, "deadline_exceeded", "(408)", "timeout")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function execOnMachine(params: {
  providerOpts: FlyProviderOpts;
  appName: string;
  machineId?: string;
  cmd: string[];
}) {
  const api = createFlyApi(params.providerOpts);
  const machineId =
    params.machineId ??
    (await resolveMachineId({
      api,
      appName: params.appName,
      machineName: "sandbox",
    }));
  const result = await flyCall(
    api,
    "POST",
    "/apps/{app_name}/machines/{machine_id}/exec",
    async () =>
      api.POST("/apps/{app_name}/machines/{machine_id}/exec", {
        params: { path: { app_name: params.appName, machine_id: machineId } },
        body: { command: params.cmd, timeout: 120 },
      }),
  );
  const r = result as { exit_code?: number; stdout?: string; stderr?: string };
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return {
    exitCode: r.exit_code ?? 0,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

async function deleteFlyResources(params: {
  providerOpts: FlyProviderOpts;
  appName: string;
  machineId?: string;
  sandboxMachineName: string;
}): Promise<void> {
  const api = createFlyApi(params.providerOpts);
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

function mapFlyMachineState(raw: string): DeploymentProviderState {
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

function serializeFlyRuntimeMetadata(value: FlyDeploymentOpts) {
  return JSON.stringify(value);
}

function parseFlyRuntimeMetadata(raw: string | undefined): FlyDeploymentOpts {
  if (!raw) {
    throw new Error("fly runtime metadata missing");
  }
  const parsed = withDefaultFlyOpts(JSON.parse(raw) as FlyDeploymentOpts);
  if (!parsed.slug) {
    throw new Error("fly runtime metadata missing slug");
  }
  return parsed;
}

function withDefaultFlyOpts(value: FlyDeploymentOpts): FlyDeploymentOpts {
  return {
    rootfsSurvivesRestart: value.rootfsSurvivesRestart ?? true,
    ...value,
  };
}

function matchesError(error: unknown, ...patterns: string[]): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return patterns.some((p) => msg.includes(p));
}

function resolveFlyMachineInit(
  value: FlyDeploymentOpts,
): components["schemas"]["fly.MachineInit"] | undefined {
  const baseInit =
    value.flyMachineInit && Object.keys(value.flyMachineInit).length > 0
      ? value.flyMachineInit
      : undefined;
  const hasSharedOverrides = value.entrypoint != null || value.cmd != null;
  if (!hasSharedOverrides) {
    return baseInit;
  }
  if (baseInit?.entrypoint && value.entrypoint) {
    throw new Error("Specify either entrypoint or flyMachineInit.entrypoint, not both");
  }
  if (baseInit?.cmd && value.cmd) {
    throw new Error("Specify either cmd or flyMachineInit.cmd, not both");
  }
  return {
    ...(baseInit ?? {}),
    ...(value.entrypoint ? { entrypoint: value.entrypoint } : {}),
    ...(value.cmd ? { cmd: value.cmd } : {}),
  };
}

function toFlyLocator(value: unknown): FlyDeploymentLocator {
  if (!value || typeof value !== "object") {
    throw new Error("fly locator must be an object");
  }
  const locator = value as Partial<FlyDeploymentLocator>;
  if (locator.provider !== "fly" || typeof locator.appName !== "string") {
    throw new Error("invalid fly locator");
  }
  if (locator.machineId != null && typeof locator.machineId !== "string") {
    throw new Error("invalid fly locator machineId");
  }
  return locator as FlyDeploymentLocator;
}

/**
 * Strips any existing authorization scheme prefix (`FlyV1 ` or `Bearer `)
 * from a token string.
 *
 * Needed because our Doppler-stored tokens include the scheme prefix
 * (e.g. "FlyV1 fm2_lJP..."), but we need the raw token value to
 * construct the correct Authorization header ourselves.
 *
 * Mirrors `StripAuthorizationScheme()` in `superfly/fly-go/tokens/tokens.go`.
 */
function stripFlyAuthScheme(token: string): string {
  return token.replace(/^(FlyV1|Bearer)\s+/i, "");
}

/**
 * Builds the correct `Authorization` header value for a Fly API token.
 *
 * ### Why this exists
 *
 * Fly has two API surfaces that accept different auth schemes:
 *
 * 1. **Machines API** (`api.machines.dev`) — accepts both `Bearer` and
 *    `FlyV1` schemes. This is the OpenAPI-specified API we use via
 *    `openapi-fetch` for creating/managing machines.
 *
 * 2. **App Logs HTTP API** (`api.fly.io/api/v1/apps/:app/logs`) — an
 *    older, undocumented-but-stable endpoint that `flyctl` uses internally
 *    for `fly logs`. This endpoint **only** accepts `FlyV1` for macaroon
 *    tokens. Sending `Bearer fm2_...` returns 401.
 *
 * ### How we figured this out
 *
 * We traced through the flyctl source code (Go, open source at
 * `github.com/superfly/flyctl`):
 *
 * - `fly logs` calls `logs.Poll()` → `client.GetAppLogs()` in
 *   `superfly/fly-go/resource_logs.go`.
 *
 * - `GetAppLogs()` sets the auth header via:
 *   ```go
 *   ctx = WithAuthorizationHeader(ctx, c.tokens.BubblegumHeader())
 *   ```
 *
 * - `BubblegumHeader()` in `superfly/fly-go/tokens/tokens.go` calls
 *   `t.normalized(false, true)`, which returns:
 *   - `"FlyV1 " + macaroon_tokens` when macaroons are present
 *   - `"Bearer " + oauth_tokens` otherwise
 *
 * - The `Transport.addAuthorization()` in `superfly/fly-go/client.go`
 *   reads this from the context and sets `req.Header["Authorization"]`.
 *
 * - Meanwhile, `AuthorizationHeader()` in `superfly/fly-go/auth.go`
 *   has the same scheme-selection logic:
 *   ```go
 *   for _, tok := range strings.Split(token, ",") {
 *       switch pfx, _, _ := strings.Cut(tok, "_"); pfx {
 *       case "fm1r", "fm2":
 *           return "FlyV1 " + token
 *       }
 *   }
 *   return "Bearer " + token
 *   ```
 *
 * Fly uses macaroon-based tokens (prefixed `fm1r_`, `fm1a_`, `fm2_`)
 * for modern auth. Older OAuth/PAT tokens don't have these prefixes.
 * The `FlyV1` scheme tells the API server to validate the token as a
 * macaroon rather than as a Bearer/OAuth token.
 *
 * ### Token format in Doppler
 *
 * Our Doppler secrets store tokens WITH the scheme prefix already
 * included (e.g. `FLY_API_TOKEN = "FlyV1 fm2_lJP..."`), so we
 * strip any existing prefix before re-adding the correct one.
 */
function flyAuthorizationHeader(token: string): string {
  const raw = stripFlyAuthScheme(token);
  for (const tok of raw.split(",")) {
    const prefix = tok.trim().split("_")[0];
    if (prefix === "fm1r" || prefix === "fm2") {
      return `FlyV1 ${raw}`;
    }
  }
  return `Bearer ${raw}`;
}
