import { execSync } from "node:child_process";
import { join } from "node:path";
import { createCommandRunner } from "./command-runner.ts";
import { runProjectDeployment } from "./project-deployment.ts";
import { runOrdersEventsProof, waitForHttpOk } from "./project-proof.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const mode = (process.argv[2] ?? "deploy") as "deploy" | "check";
if (mode !== "deploy" && mode !== "check") {
  throw new Error(`Unsupported mode: ${mode}. Use "deploy" or "check".`);
}

const containerName = process.env.JONASLAND_DOCKER_CONTAINER_NAME ?? "jonasland-sandbox-poc";
const buildPlatform = process.env.JONASLAND_SANDBOX_BUILD_PLATFORM ?? "linux/amd64";
const skipBuild = process.env.JONASLAND_SKIP_BUILD === "true";

const gitShaFull = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitShaShort = gitShaFull.slice(0, 7);
const isDirty = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" }).trim()
  .length
  ? true
  : false;
const tagSuffix = `sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;
const imageTag = process.env.JONASLAND_SANDBOX_IMAGE ?? `jonasland-sandbox:${tagSuffix}`;
const { run, runQuiet } = createCommandRunner(repoRoot);

function parseHostPortFromDockerPort(raw: string): number {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0];
  if (!first) {
    throw new Error(`docker port output empty for ${containerName}`);
  }
  const match = first.match(/:(\d+)$/);
  if (!match) {
    throw new Error(`Failed parsing docker port output: ${first}`);
  }
  return Number(match[1]);
}

function removeContainerIfExists(): void {
  try {
    runQuiet("docker", ["rm", "-f", containerName]);
  } catch {
    // ignore
  }
}

function startContainer(): void {
  run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "--cap-add",
    "NET_ADMIN",
    "-p",
    "127.0.0.1::80",
    imageTag,
  ]);
}

function assertContainerRunning(): void {
  const runningId = runQuiet("docker", [
    "ps",
    "--filter",
    `name=^/${containerName}$`,
    "--format",
    "{{.ID}}",
  ]);
  if (!runningId) {
    throw new Error(`Container ${containerName} is not running`);
  }
}

function validateIptablesRules(): void {
  const rules = runQuiet("docker", [
    "exec",
    containerName,
    "sh",
    "-lc",
    "iptables -t nat -S OUTPUT; ip6tables -t nat -S OUTPUT",
  ]);
  if (!rules.includes("--dport 80 -j REDIRECT --to-ports 80")) {
    throw new Error(`Missing redirect rule for tcp/80:\n${rules}`);
  }
  if (!rules.includes("--dport 443 -j REDIRECT --to-ports 443")) {
    throw new Error(`Missing redirect rule for tcp/443:\n${rules}`);
  }
}

function buildImageForDocker(): void {
  run("tsx", ["jonasland/sandbox/scripts/build-image.ts"], {
    env: {
      ...process.env,
      JONASLAND_SANDBOX_PUSH_FLY_REGISTRY: "false",
      JONASLAND_SANDBOX_BUILD_PLATFORM: buildPlatform,
      JONASLAND_SANDBOX_IMAGE: imageTag,
    },
  });
}

async function main(): Promise<void> {
  console.log(`mode=${mode}`);
  console.log(`container=${containerName}`);
  console.log(`image=${imageTag}`);
  let resolvedBaseUrl = "";
  const resolveBaseUrl = (): string => {
    if (resolvedBaseUrl) return resolvedBaseUrl;
    const ingressPortRaw = runQuiet("docker", ["port", containerName, "80/tcp"]);
    const ingressPort = parseHostPortFromDockerPort(ingressPortRaw);
    resolvedBaseUrl = `http://127.0.0.1:${String(ingressPort)}`;
    return resolvedBaseUrl;
  };
  const dockerProvider = async () => ({
    type: "docker" as const,
    providerId: containerName,
    imageTag,
    async getBaseUrl(): Promise<string> {
      return resolveBaseUrl();
    },
    async deploy(): Promise<void> {
      if (skipBuild) {
        console.log("skipping build (JONASLAND_SKIP_BUILD=true)");
      } else {
        buildImageForDocker();
      }
      removeContainerIfExists();
      startContainer();
    },
    async check(): Promise<void> {
      assertContainerRunning();
      const baseUrl = resolveBaseUrl();
      await waitForHttpOk({ url: `${baseUrl}/healthz`, timeoutMs: 60_000, pollMs: 750 });
      await waitForHttpOk({ url: `${baseUrl}/`, timeoutMs: 60_000, pollMs: 750 });
      validateIptablesRules();
    },
  });

  const { baseUrl } = await runProjectDeployment({
    mode,
    provider: dockerProvider,
    runProof: async ({ baseUrl: deploymentBaseUrl }) => {
      await runOrdersEventsProof({
        baseUrl: deploymentBaseUrl,
        run: runQuiet,
        logger: console.log,
        orderSku: `docker-poc-${gitShaShort}`,
      });
    },
  });

  console.log("");
  console.log("Docker POC ready:");
  console.log(`base_url=${baseUrl}`);
  console.log(`container_name=${containerName}`);
  console.log(`image=${imageTag}`);
  console.log(
    `control_events=curl -fsS -X POST -H 'content-type: application/json' --data '{"json":{"target":"events"}}' ${baseUrl}/_pidnap/rpc/processes/restart`,
  );
  console.log(
    `control_orders=curl -fsS -X POST -H 'content-type: application/json' --data '{"json":{"target":"orders"}}' ${baseUrl}/_pidnap/rpc/processes/restart`,
  );
  console.log(`events_health=curl -fsS ${baseUrl}/_events/healthz`);
  console.log(`orders_health=curl -fsS ${baseUrl}/_orders/healthz`);
}

await main();
