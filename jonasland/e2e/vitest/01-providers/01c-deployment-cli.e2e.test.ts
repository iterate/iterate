import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe } from "vitest";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import type { DeploymentProvider } from "@iterate-com/shared/jonasland/deployment/deployment-provider-manifest.ts";
import { FlyDeploymentTestEnv } from "../../test-helpers/deployment-test-env.ts";
import { test } from "../../test-support/e2e-test.ts";

const execFile = promisify(execFileCallback);
const jonaslandRoot = new URL("../../..", import.meta.url);
const baseTimeoutMs = 90_000;

type DeploymentCliCase = {
  id: "docker" | "fly";
  tags: readonly string[];
  extraTimeoutMs?: number;
  createProvider(): DeploymentProvider;
};

type CreatedDeploymentSummary = {
  provider: "docker" | "fly";
  slug: string;
  ingressHost?: string;
  ingressUrl?: string;
  locator: unknown;
  opts: unknown;
};

const cases: readonly DeploymentCliCase[] = [
  {
    id: "docker",
    tags: ["docker", "no-internet"] as const,
    createProvider: () => createDockerProvider({}),
  },
  {
    id: "fly",
    tags: ["fly", "slow"] as const,
    extraTimeoutMs: 180_000,
    createProvider: () => createFlyProvider(FlyDeploymentTestEnv.parse(process.env)),
  },
];

describe("deployment cli", () => {
  describe.concurrent.each(cases)("$id", (tc) => {
    test(
      "create waits healthy, shell works, logs stream, and destroy tears down the runtime",
      {
        tags: [...tc.tags],
        timeout: baseTimeoutMs * 2 + (tc.extraTimeoutMs ?? 0),
      },
      async ({ expect, e2e }) => {
        const provider = tc.createProvider();
        let deployment: Deployment | null = null;
        let destroyed = false;
        let created: CreatedDeploymentSummary | null = null;

        try {
          const createResult = await runCli([
            "deployment",
            "create",
            "--provider",
            tc.id,
            "--slug",
            e2e.deploymentSlug,
          ]);

          expect(createResult.exitCode).toBe(0);
          expect(createResult.output).toContain("[entry]");
          expect(createResult.output).toContain("[deployment] waiting for caddy");
          expect(createResult.output).toContain("[deployment] alive in");

          created = parseTrailingJson<CreatedDeploymentSummary>(createResult.output);
          expect(created).toMatchObject({
            provider: tc.id,
            slug: e2e.deploymentSlug,
            locator: {
              provider: tc.id,
            },
          });

          deployment = await Deployment.connect({
            provider,
            locator: created.locator,
          });

          const status = await deployment.status();
          expect(status.state).toBe("running");

          const createReady = await deployment.shellWithRetry({
            cmd: "echo deployment-cli-create-ready",
            timeoutMs: baseTimeoutMs,
            retryIf: (result) =>
              result.exitCode !== 0 || !result.stdout.includes("deployment-cli-create-ready"),
          });
          expect(createReady.stdout).toContain("deployment-cli-create-ready");

          const shellResult = await runCli([
            "deployment",
            "shell",
            "--locator",
            JSON.stringify(created.locator),
            "--cmd",
            "echo deployment-cli-shell-ok",
          ]);

          expect(shellResult.exitCode).toBe(0);
          expect(shellResult.output).toContain("deployment-cli-shell-ok");

          const logsResult = await collectCliLogsUntil({
            args: ["deployment", "logs", "--locator", JSON.stringify(created.locator)],
            needle: "[entry]",
            timeoutMs: baseTimeoutMs,
          });
          expect(logsResult.output).toContain("[entry]");
          expect(logsResult.exitCode === 0 || logsResult.signal === "SIGINT").toBe(true);

          const destroyResult = await runCli([
            "deployment",
            "destroy",
            "--locator",
            JSON.stringify(created.locator),
          ]);

          expect(destroyResult.exitCode).toBe(0);
          destroyed = true;
          deployment = null;

          await expect(
            Deployment.connect({
              provider,
              locator: created.locator,
            }),
          ).rejects.toThrow();
        } finally {
          if (deployment && !process.env.E2E_NO_DISPOSE) {
            await deployment.destroy().catch(() => {});
          } else if (created && !destroyed && !process.env.E2E_NO_DISPOSE) {
            const cleanup = await Deployment.connect({
              provider,
              locator: created.locator,
            }).catch(() => null);
            if (cleanup) {
              await cleanup.destroy().catch(() => {});
            }
          }
        }
      },
    );
  });
});

async function runCli(args: string[]) {
  try {
    const result = await execFile("pnpm", ["exec", "tsx", "./cli.ts", ...args], {
      cwd: jonaslandRoot.pathname,
      env: process.env,
    });
    return {
      exitCode: 0,
      output: `${result.stdout}${result.stderr}`,
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = Reflect.get(error, "code");
    const stdout = Reflect.get(error, "stdout");
    const stderr = Reflect.get(error, "stderr");
    return {
      exitCode: typeof code === "number" ? code : 1,
      output: `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`,
    };
  }
}

async function collectCliLogsUntil(params: { args: string[]; needle: string; timeoutMs: number }) {
  const child = spawn("pnpm", ["exec", "tsx", "./cli.ts", ...params.args], {
    cwd: jonaslandRoot.pathname,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const append = (chunk: Buffer | string) => {
    output += String(chunk);
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);

  try {
    await waitForChildOutput({
      child,
      timeoutMs: params.timeoutMs,
      predicate: (body) => body.includes(params.needle),
      output: () => output,
    });
  } finally {
    child.kill("SIGINT");
  }

  const exit = await waitForChildExit(child);
  return {
    ...exit,
    output,
  };
}

async function waitForChildOutput(params: {
  child: ReturnType<typeof spawn>;
  timeoutMs: number;
  predicate: (output: string) => boolean;
  output: () => string;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.predicate(params.output())) return;
    if (params.child.exitCode !== null) {
      throw new Error(
        `CLI process exited before expected output arrived: ${params.output() || "<no output>"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for CLI output to contain ${JSON.stringify(params.predicate.toString())}: ${
      params.output() || "<no output>"
    }`,
  );
}

async function waitForChildExit(child: ReturnType<typeof spawn>) {
  return await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    },
  );
}

function parseTrailingJson<T>(output: string) {
  const trimmed = output.trim();
  let searchFrom = trimmed.length;
  while (searchFrom >= 0) {
    const start = trimmed.lastIndexOf("{", searchFrom);
    if (start < 0) break;
    const candidate = trimmed.slice(start);
    try {
      return JSON.parse(candidate) as T;
    } catch {
      searchFrom = start - 1;
    }
  }
  throw new Error(`Could not find trailing JSON object in CLI output:\n${output}`);
}
