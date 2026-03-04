import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

function firstNonEmpty(values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) return trimmed;
  }
  return "";
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveDockerHostSync() {
  return {
    repoRoot: gitOutput(["rev-parse", "--show-toplevel"]),
    gitDir: gitOutput(["rev-parse", "--path-format=absolute", "--git-dir"]),
    commonDir: gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dockerImage = firstNonEmpty([
    process.env.E2E_DOCKER_IMAGE_REF,
    process.env.JONASLAND_SANDBOX_IMAGE,
  ]);
  if (!dockerImage) {
    throw new Error("set E2E_DOCKER_IMAGE_REF or JONASLAND_SANDBOX_IMAGE");
  }

  const dockerHostSync = resolveDockerHostSync();
  console.log(
    `[local-example] host-sync repoRoot=${dockerHostSync.repoRoot} gitDir=${dockerHostSync.gitDir} commonDir=${dockerHostSync.commonDir}`,
  );

  await using deployment = await DockerDeployment.create({
    dockerImage,
    name: `local-example-${randomUUID().slice(0, 8)}`,
    dockerHostSync,
    signal: AbortSignal.timeout(180_000),
  });

  console.log(`[local-example] deployment baseUrl=${deployment.baseUrl}`);
  await deployment.waitUntilAlive({ signal: AbortSignal.timeout(180_000) });
  console.log("[local-example] deployment alive");

  for (const configInput of serviceManifestToPidnapConfig({
    manifests: [exampleServiceManifest],
  })) {
    await deployment.pidnap.processes.updateConfig(configInput);
  }

  const waitResult = await deployment.pidnap.processes.waitFor({
    processes: { [exampleServiceManifest.slug]: "healthy" },
    timeoutMs: 120_000,
  });
  console.log(`[local-example] waitFor healthy allMet=${String(waitResult.allMet)}`);
  if (!waitResult.allMet) {
    console.log(JSON.stringify(waitResult, null, 2));
    throw new Error("example process did not become healthy");
  }

  const example = deployment.createServiceClient({ manifest: exampleServiceManifest });
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  let sawFirst502 = false;

  while (Date.now() < deadline) {
    const proc = await deployment.pidnap.processes.get({ target: exampleServiceManifest.slug });
    if (proc.state !== "running") {
      const processLogs = await deployment.exec([
        "sh",
        "-lc",
        "tail -n 80 /home/iterate/src/github.com/iterate/iterate/logs/process/example.log 2>/dev/null || true",
      ]);
      const deploymentLogs = await deployment.logs();
      const filtered = deploymentLogs
        .split("\n")
        .filter(
          (line) =>
            line.includes("pidnap:example") ||
            line.includes("services/example") ||
            line.includes("example/src") ||
            line.includes("Process exited with code"),
        )
        .slice(-120)
        .join("\n");
      console.log(
        `[local-example] process transitioned to state=${proc.state} restarts=${String(proc.restarts)}`,
      );
      console.log("[local-example] example process log tail:");
      console.log(processLogs.output);
      console.log("[local-example] filtered deployment logs:");
      console.log(filtered);
      throw new Error(`example process left running state: ${proc.state}`);
    }

    const ping = await example.things.ping({}).catch((error) => {
      lastError = error;
      return null;
    });
    if (ping?.ok) {
      console.log("[local-example] ping ok");
      console.log(`[local-example] service=${ping.service}`);
      return;
    }

    const probe = await deployment.exec([
      "sh",
      "-lc",
      "curl -sS -i -H 'Host: example.iterate.localhost' http://127.0.0.1/api/service/health || true",
    ]);
    if (!sawFirst502 && probe.output.includes("502")) {
      sawFirst502 = true;
      console.log("[local-example] first 502 seen on Caddy service health probe");
    }
    await sleep(1_000);
  }

  const proc = await deployment.pidnap.processes
    .get({ target: exampleServiceManifest.slug })
    .catch(() => null);
  if (proc) {
    console.log(
      `[local-example] final process state=${proc.state} restarts=${String(proc.restarts)} command=${proc.definition.command}`,
    );
  }
  const processLogs = await deployment.exec([
    "sh",
    "-lc",
    "tail -n 120 /home/iterate/src/github.com/iterate/iterate/logs/process/example.log 2>/dev/null || true",
  ]);
  console.log("[local-example] example process log tail:");
  console.log(processLogs.output);

  const detail =
    lastError instanceof Error ? (lastError.stack ?? lastError.message) : String(lastError);
  throw new Error(`[local-example] ping never became ok: ${detail}`);
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[local-example] fatal: ${message}`);
  process.exitCode = 1;
});
