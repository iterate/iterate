/**
 * Deploy apps/dummy-petshop (the fake third party integration e2e talks to):
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * workers.dev only — no routes, no DNS, no resources. Runs the shared
 * pipeline (scripts/lib/deploy-app.ts) against the freshly regenerated
 * wrangler.jsonc; there is no build step — wrangler bundles the TypeScript
 * entry itself, and deploy selects an env block with --env.
 *
 * PETSHOP_SEAL_KEY (seals every code/token) ships with each deploy: the
 * env's Doppler value when set, otherwise a freshly minted random key.
 * Rotation only invalidates outstanding fake tokens, which specs re-mint
 * anyway — so no Doppler setup is required to bring up an env.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { dummyPetshopEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { randomSealKey } from "../src/seal.ts";
import { writeWranglerConfig } from "./generate-wrangler-config.ts";

/** Deploy apps/dummy-petshop to a deployed environment (see scripts/lib/deploy-app.ts for the pipeline). */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/dummy-petshop",
    envs: dummyPetshopEnvs,
    dopplerProject: "dummy-petshop",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    optionalSecrets: ["PETSHOP_SEAL_KEY", "PETSHOP_BACKDOOR_SECRET"],
    build: "checked-in-config",
    prepare: (_ctx, secretValues) => {
      writeWranglerConfig({ forDeployment: true });
      secretValues.PETSHOP_SEAL_KEY ??= randomSealKey();
    },
    smokes: (env) => [
      { url: `${env.baseUrl}/`, ok: (status) => status === 200, label: "shop index" },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
