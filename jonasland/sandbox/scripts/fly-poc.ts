import { execSync } from "node:child_process";
import { join } from "node:path";
import { createCommandRunner } from "./command-runner.ts";
import { registerCfProxyRoutes, resolveCfProxyRunId } from "./cf-proxy-routes.ts";
import { runProjectDeployment } from "./project-deployment.ts";
import { runOrdersEventsProof, waitForHttpOk } from "./project-proof.ts";

type FlyMachine = {
  id?: string;
  name?: string;
  state?: string;
  created_at?: string;
};

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const mode = (process.argv[2] ?? "deploy") as "deploy" | "check";
if (mode !== "deploy" && mode !== "check") {
  throw new Error(`Unsupported mode: ${mode}. Use "deploy" or "check".`);
}

const appName = process.env.JONASLAND_FLY_APP ?? "jonasland-sandbox";
const org = process.env.JONASLAND_FLY_ORG ?? process.env.FLY_ORG ?? "iterate";
const region = process.env.JONASLAND_FLY_REGION ?? "ord";
const buildPlatform = process.env.JONASLAND_SANDBOX_BUILD_PLATFORM ?? "linux/amd64";
const skipBuild = process.env.JONASLAND_SKIP_BUILD === "true";
const vmCpuKind = process.env.JONASLAND_FLY_VM_CPU_KIND ?? "shared";
const vmCpus = process.env.JONASLAND_FLY_VM_CPUS ?? "2";
const vmMemory = process.env.JONASLAND_FLY_VM_MEMORY_MB ?? "2048";
const cfProxyMode = process.env.JONASLAND_CF_PROXY_ENABLE ?? "auto";
const cfProxyTtlSeconds = Number(process.env.JONASLAND_CF_PROXY_TTL_SECONDS ?? "21600");

const gitShaFull = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitShaShort = gitShaFull.slice(0, 7);
const isDirty = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" }).trim()
  .length
  ? true
  : false;
const tagSuffix =
  process.env.JONASLAND_SANDBOX_TAG_SUFFIX ?? `sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;
const imageTag = process.env.JONASLAND_FLY_IMAGE ?? `registry.fly.io/${appName}:${tagSuffix}`;
const baseUrl = `https://${appName}.fly.dev`;
const defaultCfRunId = `${appName}-${gitShaShort}`;
const { run, runQuiet, runJson } = createCommandRunner(repoRoot);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureAppExists(): void {
  try {
    run("flyctl", ["status", "-a", appName], { quiet: true });
    console.log(`fly app exists: ${appName}`);
  } catch {
    console.log(`creating fly app: ${appName} (org=${org})`);
    run("flyctl", ["apps", "create", appName, "--org", org, "--yes"]);
  }
}

function ensureSharedIpv4(): void {
  const ips = runJson<Array<{ family?: string; Address?: string; Type?: string }>>("flyctl", [
    "ips",
    "list",
    "-a",
    appName,
    "--json",
  ]);
  const hasV4 = ips.some(
    (ip) =>
      ip.family === "v4" ||
      ip.Type === "shared_v4" ||
      ip.Type === "v4" ||
      ip.Address?.includes("."),
  );
  if (hasV4) {
    console.log("shared IPv4 already allocated");
    return;
  }
  console.log("allocating shared IPv4");
  run("flyctl", ["ips", "allocate-v4", "-a", appName, "--shared", "--yes"]);
}

function buildAndPushImage(): void {
  console.log(`building and pushing image via shared build script (target=${imageTag})`);
  run("tsx", ["jonasland/sandbox/scripts/build-image.ts"], {
    env: {
      ...process.env,
      JONASLAND_SANDBOX_SKIP_LOAD: "true",
      JONASLAND_SANDBOX_PUSH_FLY_REGISTRY: "true",
      JONASLAND_FLY_REGISTRY_APP: appName,
      JONASLAND_SANDBOX_BUILD_PLATFORM: buildPlatform,
    },
  });
}

function listMachines(): FlyMachine[] {
  return runJson<FlyMachine[]>("flyctl", ["machine", "list", "-a", appName, "--json"]);
}

function destroyExistingMachines(): void {
  const machines = listMachines();
  if (machines.length === 0) {
    console.log("no existing machines to destroy");
    return;
  }
  for (const machine of machines) {
    if (!machine.id) continue;
    console.log(`destroying machine: ${machine.id}`);
    run("flyctl", ["machine", "destroy", machine.id, "-a", appName, "--force"]);
  }
}

async function runMachine(): Promise<void> {
  console.log(`creating machine from image: ${imageTag}`);
  run("flyctl", [
    "machine",
    "run",
    imageTag,
    "--app",
    appName,
    "--org",
    org,
    "--region",
    region,
    "--name",
    "sandbox",
    "--detach",
    "--restart",
    "always",
    "--vm-cpu-kind",
    vmCpuKind,
    "--vm-cpus",
    vmCpus,
    "--vm-memory",
    vmMemory,
    "--port",
    "80:80/tcp:http",
    "--port",
    "443:80/tcp:http:tls",
  ]);
}

function latestSandboxMachine(): FlyMachine | undefined {
  return listMachines()
    .filter((machine) => machine.name === "sandbox" && machine.id)
    .sort((a, b) => {
      const aa = a.created_at ? Date.parse(a.created_at) : 0;
      const bb = b.created_at ? Date.parse(b.created_at) : 0;
      return bb - aa;
    })[0];
}

async function waitForMachineStarted(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sandboxMachine = latestSandboxMachine();

    if (sandboxMachine?.id && sandboxMachine.state === "started") {
      return sandboxMachine.id;
    }
    await sleep(2000);
  }
  throw new Error("Timed out waiting for Fly machine to reach started state");
}

async function main(): Promise<void> {
  console.log(`mode=${mode}`);
  console.log(`app=${appName} org=${org} region=${region}`);
  console.log(`image=${imageTag}`);
  console.log(`url=${baseUrl}`);
  if (!Number.isFinite(cfProxyTtlSeconds) || cfProxyTtlSeconds <= 0) {
    throw new Error(`Invalid JONASLAND_CF_PROXY_TTL_SECONDS: ${String(cfProxyTtlSeconds)}`);
  }

  const hasCfProxyToken = Boolean(process.env.CF_PROXY_WORKER_API_TOKEN);
  const useCfProxy = cfProxyMode === "true" || (cfProxyMode === "auto" && hasCfProxyToken);
  if (cfProxyMode === "true" && !hasCfProxyToken) {
    throw new Error("JONASLAND_CF_PROXY_ENABLE=true but CF_PROXY_WORKER_API_TOKEN is missing");
  }
  const cfProxyRunId = resolveCfProxyRunId(defaultCfRunId);

  const flyProvider = async () => ({
    type: "fly" as const,
    providerId: appName,
    imageTag,
    async getBaseUrl(): Promise<string> {
      return baseUrl;
    },
    async deploy(): Promise<void> {
      ensureAppExists();
      ensureSharedIpv4();
      if (skipBuild) {
        console.log("skipping build and push (JONASLAND_SKIP_BUILD=true)");
      } else {
        buildAndPushImage();
      }
      destroyExistingMachines();
      await runMachine();
      const machineId = await waitForMachineStarted(120_000);
      console.log(`machine started: ${machineId}`);
    },
    async check(): Promise<void> {
      await waitForHttpOk({
        url: `${baseUrl}/healthz`,
        timeoutMs: 120_000,
        pollMs: 1_500,
      });
      await waitForHttpOk({
        url: `${baseUrl}/`,
        timeoutMs: 120_000,
        pollMs: 1_500,
      });
      console.log("ingress healthy");
    },
  });

  let cfProxyUrls:
    | {
        runId: string;
        registryUrl: string;
        pidnapUrl: string;
        eventsUrl: string;
        ordersUrl: string;
      }
    | undefined;

  const { baseUrl: resolvedBaseUrl } = await runProjectDeployment({
    mode,
    provider: flyProvider,
    runProof: async ({ baseUrl: deploymentBaseUrl }) => {
      let proofBaseUrl = deploymentBaseUrl;
      let proofRoutes:
        | {
            pidnapBaseUrl: string;
            eventsBaseUrl: string;
            ordersBaseUrl: string;
          }
        | undefined;

      if (useCfProxy) {
        const routeSet = await registerCfProxyRoutes({
          targetBaseUrl: deploymentBaseUrl,
          runId: cfProxyRunId,
          ttlSeconds: cfProxyTtlSeconds,
          logger: console.log,
        });
        await waitForHttpOk({
          url: `${routeSet.urls.registry}/healthz`,
          timeoutMs: 45_000,
          pollMs: 1_000,
        });
        proofBaseUrl = routeSet.urls.registry;
        proofRoutes = {
          pidnapBaseUrl: routeSet.urls.pidnap,
          eventsBaseUrl: routeSet.urls.events,
          ordersBaseUrl: routeSet.urls.orders,
        };
        cfProxyUrls = {
          runId: routeSet.runId,
          registryUrl: routeSet.urls.registry,
          pidnapUrl: routeSet.urls.pidnap,
          eventsUrl: routeSet.urls.events,
          ordersUrl: routeSet.urls.orders,
        };
      } else if (cfProxyMode === "auto") {
        console.log("cf-proxy skipped (CF_PROXY_WORKER_API_TOKEN not set)");
      }

      await runOrdersEventsProof({
        baseUrl: proofBaseUrl,
        routes: proofRoutes,
        run: runQuiet,
        logger: console.log,
        orderSku: `fly-poc-${gitShaShort}`,
      });
    },
  });

  const publicBaseUrl = cfProxyUrls?.registryUrl ?? resolvedBaseUrl;
  const publicControlBase = cfProxyUrls?.pidnapUrl ?? `${resolvedBaseUrl}/_pidnap`;
  const publicEventsHealth = cfProxyUrls?.eventsUrl
    ? `${cfProxyUrls.eventsUrl}/healthz`
    : `${resolvedBaseUrl}/_events/healthz`;
  const publicOrdersHealth = cfProxyUrls?.ordersUrl
    ? `${cfProxyUrls.ordersUrl}/healthz`
    : `${resolvedBaseUrl}/_orders/healthz`;

  console.log("");
  console.log("POC ready:");
  console.log(`fly_base_url=${resolvedBaseUrl}`);
  console.log(`base_url=${publicBaseUrl}`);
  console.log(`image=${imageTag}`);
  if (cfProxyUrls) {
    console.log(`cf_proxy_run_id=${cfProxyUrls.runId}`);
    console.log(`cf_proxy_registry_url=${cfProxyUrls.registryUrl}`);
    console.log(`cf_proxy_pidnap_url=${cfProxyUrls.pidnapUrl}`);
    console.log(`cf_proxy_events_url=${cfProxyUrls.eventsUrl}`);
    console.log(`cf_proxy_orders_url=${cfProxyUrls.ordersUrl}`);
  }
  console.log(
    `control_events=curl -fsS -X POST -H 'content-type: application/json' --data '{"json":{"target":"events"}}' ${publicControlBase}/rpc/processes/restart`,
  );
  console.log(
    `control_orders=curl -fsS -X POST -H 'content-type: application/json' --data '{"json":{"target":"orders"}}' ${publicControlBase}/rpc/processes/restart`,
  );
  console.log(`events_health=curl -fsS ${publicEventsHealth}`);
  console.log(`orders_health=curl -fsS ${publicOrdersHealth}`);
}

await main();
