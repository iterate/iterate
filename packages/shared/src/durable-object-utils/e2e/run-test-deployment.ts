import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { env, platform, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { slugify } from "../../slugify.ts";

type CommandOptions = {
  readonly env?: Record<string, string>;
  readonly allowFailure?: boolean;
};

type DeploymentOutput = {
  readonly url?: string;
  readonly routes?: readonly string[];
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const stage = env.ALCHEMY_STAGE ?? slugify(`do-utils-e2e-${Date.now().toString(36)}`);
const alchemyEntrypoint = "./src/durable-object-utils/e2e/alchemy.run.ts";

let deployed = false;
let failed = false;

try {
  const deployOutput = run(
    "pnpm",
    ["exec", "alchemy", "deploy", alchemyEntrypoint, "--stage", stage, "--quiet"],
    {
      env: {
        ALCHEMY_STAGE: stage,
        DURABLE_OBJECT_UTILS_E2E_OUTPUT_JSON: "1",
      },
    },
  );
  deployed = true;

  const baseUrl = getBaseUrl(deployOutput);
  run(
    "pnpm",
    ["exec", "vitest", "run", "--config", "./src/durable-object-utils/e2e/vitest.config.ts"],
    {
      env: {
        DURABLE_OBJECT_UTILS_E2E_BASE_URL: baseUrl,
      },
    },
  );
} catch (error) {
  failed = true;
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  if (deployed) {
    try {
      run("pnpm", ["exec", "alchemy", "destroy", alchemyEntrypoint, "--stage", stage, "--quiet"], {
        env: {
          ALCHEMY_STAGE: stage,
          DURABLE_OBJECT_UTILS_E2E_OUTPUT_JSON: "1",
        },
        allowFailure: true,
      });
    } catch (error) {
      failed = true;
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

if (failed) {
  process.exitCode = 1;
}

function run(command: string, args: readonly string[], options: CommandOptions = {}): string {
  stdout.write(`$ ${command} ${args.join(" ")}\n`);

  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: {
      ...env,
      ...options.env,
    },
    shell: platform === "win32",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stdout.length > 0) stdout.write(result.stdout);
  if (result.stderr.length > 0) stderr.write(result.stderr);

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`Command failed with exit code ${result.status}: ${command} ${args.join(" ")}`);
  }

  return result.stdout;
}

function getBaseUrl(output: string): string {
  const deployment = parseDeploymentOutput(output);

  if (deployment.url !== undefined && deployment.url.length > 0) {
    return deployment.url;
  }

  const [route] = deployment.routes ?? [];
  if (route !== undefined) {
    return `https://${route}`;
  }

  throw new Error(
    "Alchemy deployment did not report a worker URL. Set DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES to a hostname route or enable workers.dev for the account.",
  );
}

function parseDeploymentOutput(output: string): DeploymentOutput {
  const jsonLine = output
    .trim()
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));

  if (jsonLine === undefined) {
    throw new Error("Alchemy deployment output did not include deployment JSON.");
  }

  const parsed: unknown = JSON.parse(jsonLine);

  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Alchemy deployment JSON was not an object.");
  }

  const record = parsed as Record<string, unknown>;
  const routes = Array.isArray(record.routes)
    ? record.routes.filter((route): route is string => typeof route === "string")
    : undefined;

  return {
    url: typeof record.url === "string" ? record.url : undefined,
    routes,
  };
}
