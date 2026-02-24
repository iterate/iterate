import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";

const canUseDocker =
  process.env.PIDNAP_RUN_DOCKER_TESTS === "1" &&
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const describeDocker = canUseDocker ? describe : describe.skip;

const imageTag = `pidnap-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
const tempRoot = join(tmpdir(), `pidnap-docker-test-${Date.now()}-${randomUUID().slice(0, 8)}`);
const workspaceDir = join(tempRoot, "workspace");
const homeDir = join(tempRoot, "home");
const configPath = join(workspaceDir, "pidnap.config.ts");
const autosavePath = join(homeDir, ".iterate", "pidnap-autosave.json");
const processSlug = "docker-autosave-proc";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf-8" }).trim();
}

function startContainer(): { name: string; rpcUrl: string } {
  const name = `pidnap-test-${randomUUID().slice(0, 8)}`;
  docker([
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-w",
    "/workspace",
    "-e",
    "HOME=/home/pidnap",
    "-v",
    `${workspaceDir}:/workspace`,
    "-v",
    `${homeDir}:/home/pidnap`,
    "-p",
    "127.0.0.1::9876",
    imageTag,
    "pidnap",
    "init",
    "--config",
    "/workspace/pidnap.config.ts",
  ]);
  const mapping = docker(["port", name, "9876/tcp"]);
  const port = mapping.split(":").pop();
  if (!port) {
    throw new Error(`Failed to parse docker port mapping: "${mapping}"`);
  }
  return { name, rpcUrl: `http://127.0.0.1:${port}/rpc` };
}

async function waitForRpcReady(rpcUrl: string, timeoutMs = 60_000): Promise<void> {
  const client = createClient(rpcUrl);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await client.health();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for pidnap RPC at ${rpcUrl}`);
}

function stopContainer(name: string): void {
  docker(["stop", "-t", "2", name]);
}

describeDocker("pidnap docker autosave", () => {
  beforeAll(() => {
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(configPath, 'export default { http: { host: "0.0.0.0" } };\n', "utf-8");
    docker(["build", "-t", imageTag, "-f", "Dockerfile.example", "."]);
  }, 300_000);

  afterAll(() => {
    try {
      docker(["rmi", "-f", imageTag]);
    } catch {
      // Best effort cleanup.
    }
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists updateConfig and delete across container restarts", async () => {
    const first = startContainer();
    try {
      await waitForRpcReady(first.rpcUrl);
      const firstClient = createClient(first.rpcUrl);

      await firstClient.processes.updateConfig({
        processSlug,
        definition: {
          command: "node",
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
        persistence: "durable",
        desiredState: "running",
      });

      const started = await firstClient.processes.waitForRunning({
        target: processSlug,
        timeoutMs: 30_000,
      });
      expect(started.state).toBe("running");
    } finally {
      stopContainer(first.name);
    }

    expect(existsSync(autosavePath)).toBe(true);
    const autosaveAfterCreate = JSON.parse(readFileSync(autosavePath, "utf-8"));
    expect(autosaveAfterCreate.processes?.[processSlug]?.name).toBe(processSlug);

    const second = startContainer();
    try {
      await waitForRpcReady(second.rpcUrl);
      const secondClient = createClient(second.rpcUrl);

      const restored = await secondClient.processes.get({ target: processSlug });
      expect(restored.source).toBe("overlay");

      await secondClient.processes.delete({ processSlug });
      await expect(secondClient.processes.get({ target: processSlug })).rejects.toThrow(
        /not found|NOT_FOUND/i,
      );
    } finally {
      stopContainer(second.name);
    }

    const third = startContainer();
    try {
      await waitForRpcReady(third.rpcUrl);
      const thirdClient = createClient(third.rpcUrl);
      await expect(thirdClient.processes.get({ target: processSlug })).rejects.toThrow(
        /not found|NOT_FOUND/i,
      );
    } finally {
      stopContainer(third.name);
    }

    const autosaveAfterDelete = JSON.parse(readFileSync(autosavePath, "utf-8"));
    expect(autosaveAfterDelete.processes?.[processSlug]).toBeUndefined();
  }, 300_000);
});
