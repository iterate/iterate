import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dedent from "dedent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";

const canUseDocker =
  process.env.PIDNAP_RUN_DOCKER_TESTS === "1" &&
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const describeDocker = canUseDocker ? describe : describe.skip;

const imageTag = `pidnap-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
const tempRoot = join(
  tmpdir(),
  `pidnap-docker-env-watch-${Date.now()}-${randomUUID().slice(0, 8)}`,
);
const processSlug = "env-server";
const envServerPort = 19080;

/**
 * This is an important regression test because it exercises the real boundary
 * where the jonasland bug showed up:
 *
 * - pidnap runs as a parent process inside Docker
 * - pidnap watches a real `.env` file on disk
 * - pidnap merges env from three places that matter here:
 *   - the watched `.env` file
 *   - the pidnap parent process environment
 *   - the process definition's own `env` block
 * - the child process is a tiny HTTP server that reports its live `process.env`
 *
 * We care about two classes of bugs:
 *
 * 1. runtime env composition bugs
 *    Does the child process see the right merged env at startup when those
 *    three sources interact?
 *
 * 2. env-triggered restart gating bugs
 *    After rewriting the watched `.env` file, does pidnap correctly decide
 *    whether a process must be restarted when `onlyRestartIfChanged` is set?
 *
 * The jonasland `caddy` issue lives in the overlap of those two behaviors:
 * `ITERATE_EGRESS_PROXY` comes from the watched global env file, while the
 * process also has static env in its definition. This file keeps that shape
 * explicit and proves behavior via a real child process instead of only
 * asserting against pidnap's internal config snapshot.
 */
describeDocker("pidnap docker env watch", () => {
  const cases = [
    {
      name: "ungated global env reload without static process env",
      envFileContentsBeforeUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-before
        UNRELATED_VAR=before
      `,
      envFileContentsAfterUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-after
        UNRELATED_VAR=after
      `,
      pidnapProcessEnv: undefined,
      envInProcessDefinition: undefined,
      envOptions: {
        reloadDelay: "immediately" as const,
      },
      initialExpectedEnv: {
        ITERATE_EGRESS_PROXY: "http://proxy-before",
      },
      expectedEnv: {
        ITERATE_EGRESS_PROXY: "http://proxy-after",
      },
    },
    {
      name: "gated global env reload without static process env",
      envFileContentsBeforeUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-before
        UNRELATED_VAR=before
      `,
      envFileContentsAfterUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-after
        UNRELATED_VAR=after
      `,
      pidnapProcessEnv: undefined,
      envInProcessDefinition: undefined,
      envOptions: {
        reloadDelay: "immediately" as const,
        onlyRestartIfChanged: ["ITERATE_EGRESS_PROXY"],
      },
      initialExpectedEnv: {
        ITERATE_EGRESS_PROXY: "http://proxy-before",
      },
      expectedEnv: {
        ITERATE_EGRESS_PROXY: "http://proxy-after",
      },
    },
    {
      name: "gated global env reload with static process env",
      envFileContentsBeforeUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-before
        UNRELATED_VAR=before
      `,
      envFileContentsAfterUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-after
        UNRELATED_VAR=after
      `,
      pidnapProcessEnv: undefined,
      envInProcessDefinition: {
        HOME: "/home/pidnap",
        STATIC_PROCESS_ENV: "present",
      },
      envOptions: {
        reloadDelay: "immediately" as const,
        onlyRestartIfChanged: ["ITERATE_EGRESS_PROXY"],
      },
      initialExpectedEnv: {
        HOME: "/home/pidnap",
        STATIC_PROCESS_ENV: "present",
        ITERATE_EGRESS_PROXY: "http://proxy-before",
      },
      expectedEnv: {
        HOME: "/home/pidnap",
        STATIC_PROCESS_ENV: "present",
        ITERATE_EGRESS_PROXY: "http://proxy-after",
      },
    },
    {
      name: "gated process ignores global env when inheritGlobalEnv is false",
      envFileContentsBeforeUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-before
        UNRELATED_VAR=before
      `,
      envFileContentsAfterUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-after
        UNRELATED_VAR=after
      `,
      pidnapProcessEnv: undefined,
      envInProcessDefinition: {
        HOME: "/home/pidnap",
        STATIC_PROCESS_ENV: "present",
      },
      envOptions: {
        inheritGlobalEnv: false,
        reloadDelay: "immediately" as const,
        onlyRestartIfChanged: ["ITERATE_EGRESS_PROXY"],
      },
      initialExpectedEnv: {
        HOME: "/home/pidnap",
        STATIC_PROCESS_ENV: "present",
      },
      expectedEnv: {
        HOME: "/home/pidnap",
        STATIC_PROCESS_ENV: "present",
      },
    },
    {
      name: "pidnap parent process env is inherited by default",
      envFileContentsBeforeUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-before
        UNRELATED_VAR=before
      `,
      envFileContentsAfterUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-after
        UNRELATED_VAR=after
      `,
      pidnapProcessEnv: {
        PIDNAP_PARENT_ONLY: "present-in-parent",
      },
      envInProcessDefinition: undefined,
      envOptions: {
        reloadDelay: "immediately" as const,
      },
      initialExpectedEnv: {
        PIDNAP_PARENT_ONLY: "present-in-parent",
        ITERATE_EGRESS_PROXY: "http://proxy-before",
      },
      expectedEnv: {
        PIDNAP_PARENT_ONLY: "present-in-parent",
        ITERATE_EGRESS_PROXY: "http://proxy-after",
      },
    },
    {
      name: "process definition env overrides pidnap parent process env",
      envFileContentsBeforeUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-before
      `,
      envFileContentsAfterUpdate: dedent`
        ITERATE_EGRESS_PROXY=http://proxy-after
      `,
      pidnapProcessEnv: {
        SHARED_PRIORITY_KEY: "from-pidnap-parent",
      },
      envInProcessDefinition: {
        SHARED_PRIORITY_KEY: "from-process-definition",
      },
      envOptions: {
        reloadDelay: "immediately" as const,
      },
      initialExpectedEnv: {
        SHARED_PRIORITY_KEY: "from-process-definition",
        ITERATE_EGRESS_PROXY: "http://proxy-before",
      },
      expectedEnv: {
        SHARED_PRIORITY_KEY: "from-process-definition",
        ITERATE_EGRESS_PROXY: "http://proxy-after",
      },
    },
  ] as const;

  beforeAll(() => {
    mkdirSync(tempRoot, { recursive: true });
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

  it.concurrent.each(cases)(
    "resolves env over /env for $name",
    async ({
      envFileContentsBeforeUpdate,
      envFileContentsAfterUpdate,
      pidnapProcessEnv,
      envInProcessDefinition,
      envOptions,
      initialExpectedEnv,
      expectedEnv,
    }) => {
      const testPaths = createTestPaths();

      writeFileSync(testPaths.envFilePath, `${envFileContentsBeforeUpdate}\n`, "utf-8");
      writeFileSync(
        testPaths.serverScriptPath,
        dedent`
          const { createServer } = require("node:http");

          createServer((req, res) => {
            if ((req.url || "") !== "/env") {
              res.statusCode = 404;
              res.end("not found");
              return;
            }

            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(process.env));
          }).listen(${String(envServerPort)}, "0.0.0.0");

          setInterval(() => {}, 1000);
        `,
        "utf-8",
      );
      writeFileSync(
        testPaths.configPath,
        dedent`
          export default {
            http: { host: "0.0.0.0" },
            cwd: "/workspace",
            envFile: "/workspace/.env",
            processes: [
              {
                name: "${processSlug}",
                definition: {
                  command: "node",
                  args: ["/workspace/env-server.cjs"],
                  ${envInProcessDefinition ? `env: ${JSON.stringify(envInProcessDefinition)},` : ""}
                },
                envOptions: ${JSON.stringify(envOptions)},
              },
            ],
          };
        `,
        "utf-8",
      );

      const container = startContainer({
        pidnapProcessEnv,
        workspaceDir: testPaths.workspaceDir,
        homeDir: testPaths.homeDir,
      });
      try {
        await waitForRpcReady({
          rpcUrl: container.rpcUrl,
          containerName: container.name,
        });
        const client = createClient(container.rpcUrl);

        const started = await client.processes.waitForRunning({
          processSlug,
          timeoutMs: 30_000,
        });
        expect(started.state).toBe("running");

        // The runtime `/env` assertion matters more than a config snapshot. We
        // want to know what the child process actually sees after pidnap starts
        // it and after pidnap reacts to the env-file rewrite.
        await expect
          .poll(async () => await readEnvOverHttp(container.envUrl), {
            timeout: 15_000,
            interval: 250,
          })
          .toMatchObject(initialExpectedEnv);

        writeFileSync(testPaths.envFilePath, `${envFileContentsAfterUpdate}\n`, "utf-8");

        await expect
          .poll(async () => await readEnvOverHttp(container.envUrl), {
            timeout: 15_000,
            interval: 250,
          })
          .toMatchObject(expectedEnv);
      } finally {
        stopContainer(container.name);
      }
    },
    300_000,
  );
});

function docker(args: string[]) {
  return execFileSync("docker", args, { encoding: "utf-8" }).trim();
}

function readMappedPort(containerName: string, internalPort: number) {
  const mapping = docker(["port", containerName, `${String(internalPort)}/tcp`]);
  const port = mapping.split(":").pop();
  if (!port) {
    throw new Error(
      `Failed to parse docker port mapping for ${String(internalPort)}: "${mapping}"`,
    );
  }
  return port;
}

function startContainer(params: {
  pidnapProcessEnv: Record<string, string> | undefined;
  workspaceDir: string;
  homeDir: string;
}) {
  const name = `pidnap-env-watch-${randomUUID().slice(0, 8)}`;
  const envArgs = Object.entries(params.pidnapProcessEnv ?? {}).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  docker([
    "run",
    "-d",
    "--name",
    name,
    "-w",
    "/workspace",
    "-e",
    "HOME=/home/pidnap",
    "-v",
    `${params.workspaceDir}:/workspace`,
    "-v",
    `${params.homeDir}:/home/pidnap`,
    ...envArgs,
    "-p",
    "127.0.0.1::9876",
    "-p",
    `127.0.0.1::${String(envServerPort)}`,
    imageTag,
    "pidnap",
    "init",
    "--config",
    "/workspace/pidnap.config.ts",
  ]);
  const rpcPort = readMappedPort(name, 9876);
  const envPort = readMappedPort(name, envServerPort);
  return {
    name,
    rpcUrl: `http://127.0.0.1:${rpcPort}/rpc`,
    envUrl: `http://127.0.0.1:${envPort}/env`,
  };
}

async function waitForRpcReady(params: {
  rpcUrl: string;
  containerName: string;
  timeoutMs?: number;
}) {
  const client = createClient(params.rpcUrl);
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await client.health();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  let logs = "";
  try {
    logs = docker(["logs", params.containerName]);
  } catch {}
  throw new Error(
    `Timed out waiting for pidnap RPC at ${params.rpcUrl}${logs ? `\ncontainer logs:\n${logs}` : ""}`,
  );
}

async function readEnvOverHttp(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${String(response.status)}`);
  }
  return (await response.json()) as Record<string, string>;
}

function stopContainer(name: string) {
  try {
    docker(["rm", "-f", name]);
  } catch {}
}

function createTestPaths() {
  const rootDir = join(tempRoot, randomUUID().slice(0, 8));
  const workspaceDir = join(rootDir, "workspace");
  const homeDir = join(rootDir, "home");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    workspaceDir,
    homeDir,
    configPath: join(workspaceDir, "pidnap.config.ts"),
    envFilePath: join(workspaceDir, ".env"),
    serverScriptPath: join(workspaceDir, "env-server.cjs"),
  };
}
