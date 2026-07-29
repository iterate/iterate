import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { authEnvs, envs } from "../envs.ts";
import { alchemyResourcesPath } from "./lib/alchemy-resources.ts";
import { run } from "./lib/deploy-helpers.ts";
import { loadDopplerSecrets } from "./lib/env-context.ts";

const INFRA_ROOT = fileURLToPath(new URL("../infra", import.meta.url));

function installDependencies() {
  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: INFRA_ROOT });
}

function credentialsForEnvironment(envName: string) {
  const env = Object.values(authEnvs).find((candidate) => candidate.dopplerConfig === envName);
  if (!env) throw new Error(`Unknown deployed environment ${envName}.`);
  const secrets = loadDopplerSecrets("auth", env.dopplerConfig);
  if (secrets.CLOUDFLARE_ACCOUNT_ID !== env.cloudflareAccountId) {
    throw new Error(
      `Doppler config auth/${env.dopplerConfig} does not target ${env.cloudflareAccountId}.`,
    );
  }
  const apiToken = secrets.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error(`auth/${env.dopplerConfig} is missing CLOUDFLARE_API_TOKEN.`);
  return {
    CLOUDFLARE_API_TOKEN: apiToken,
    CLOUDFLARE_ACCOUNT_ID: env.cloudflareAccountId,
  };
}

/** Apply one environment's Alchemy-owned data resources. */
export function deploy(options: { env: string }) {
  const credentials = credentialsForEnvironment(options.env);
  installDependencies();
  const outputPath = alchemyResourcesPath(options.env);
  rmSync(outputPath, { force: true });
  try {
    run("pnpm", ["exec", "alchemy", "deploy", "alchemy.run.ts", "--stage", options.env, "--yes"], {
      cwd: INFRA_ROOT,
      env: credentials,
    });
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw error;
  }
}

/** Destroy one environment's whole Alchemy stack and its generated output. */
export function destroy(options: {
  env: string;
  afterWorkerDataReset?: boolean;
  yesIMeanPrd?: boolean;
}) {
  const platformEnvironment = Object.values(envs).some(
    (environment) => environment.dopplerConfig === options.env,
  );
  if (options.env === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to destroy PRODUCTION data without --yes-i-mean-prd.");
  }
  if (platformEnvironment && !options.afterWorkerDataReset) {
    throw new Error(`${options.env} includes Worker data; erase it through apps/os.`);
  }
  const credentials = credentialsForEnvironment(options.env);
  installDependencies();
  rmSync(alchemyResourcesPath(options.env), { force: true });
  run("pnpm", ["exec", "alchemy", "destroy", "alchemy.run.ts", "--stage", options.env, "--yes"], {
    cwd: INFRA_ROOT,
    env: credentials,
  });
}

void createCli({ ...import.meta, name: "infra" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
