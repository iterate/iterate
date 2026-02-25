import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import { createProjectDeploymentProvider, runProjectDeployment } from "./project-deployment.ts";
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

const gitShaFull = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitShaShort = gitShaFull.slice(0, 7);
const isDirty = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" }).trim()
  .length
  ? true
  : false;
const tagSuffix = `sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;
const imageTag = process.env.JONASLAND_FLY_IMAGE ?? `registry.fly.io/${appName}:${tagSuffix}`;
const baseUrl = `https://${appName}.fly.dev`;

function run(
  command: string,
  args: string[],
  options?: { quiet?: boolean; env?: NodeJS.ProcessEnv },
): string {
  if (options?.quiet) {
    return execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf-8",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf-8",
    env: options?.env ?? process.env,
    stdio: "inherit",
  });
  return "";
}

function runJson<T>(command: string, args: string[]): T {
  const out = run(command, args, { quiet: true });
  return JSON.parse(out) as T;
}

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
  const runQuiet = (command: string, args: string[]): string => run(command, args, { quiet: true });
  const flyProvider = createProjectDeploymentProvider({
    createDeployment: async () => ({
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
    }),
  });

  const { baseUrl: resolvedBaseUrl } = await runProjectDeployment({
    mode,
    provider: flyProvider,
    runProof: async ({ baseUrl: deploymentBaseUrl }) => {
      await runOrdersEventsProof({
        baseUrl: deploymentBaseUrl,
        run: runQuiet,
        logger: console.log,
        orderSku: `fly-poc-${gitShaShort}`,
      });
    },
  });

  console.log("");
  console.log("POC ready:");
  console.log(`base_url=${resolvedBaseUrl}`);
  console.log(`image=${imageTag}`);
  console.log(
    `control_events=curl -fsS -X POST -H 'content-type: application/json' --data '{\"json\":{\"target\":\"events\"}}' ${resolvedBaseUrl}/_pidnap/rpc/processes/restart`,
  );
  console.log(
    `control_orders=curl -fsS -X POST -H 'content-type: application/json' --data '{\"json\":{\"target\":\"orders\"}}' ${resolvedBaseUrl}/_pidnap/rpc/processes/restart`,
  );
  console.log(`events_health=curl -fsS ${resolvedBaseUrl}/_events/healthz`);
  console.log(`orders_health=curl -fsS ${resolvedBaseUrl}/_orders/healthz`);
}

await main();
