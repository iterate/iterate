/**
 * Deploy apps/tunnels (the captun gateway):
 *
 *   pnpm run deploy --env prd
 *
 * Runs the shared pipeline (scripts/lib/deploy-app.ts). No build step:
 * wrangler bundles the TypeScript entry itself. Secrets ride
 * `wrangler deploy --secrets-file`, so code + secrets land in one version
 * (after adopting the DO migration tag on alchemy-era scripts — see
 * deploy-helpers.ts).
 *
 * CAUTION: never delete tunnels-prd. Every dev environment's public tunnels
 * ride it, and force-deleting a worker script CASCADES its zone routes —
 * re-uploading does not bring them back (the zombie-route/522 class). Always
 * deploy over the live worker.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { tunnelsEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** Deploy apps/tunnels (the captun gateway) — see scripts/lib/deploy-app.ts for the pipeline. */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/tunnels",
    envs: tunnelsEnvs,
    dopplerProject: "tunnels",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => `https://${env.hostname}`,
    requiredSecrets: ["CAPTUN_TOKEN"],
    // The checked-in wrangler.jsonc carries the env blocks, so deploy selects
    // one with --env instead of a built per-env config.
    build: "checked-in-config",
    smokes: (env) => [
      { url: `https://${env.hostname}/`, ok: (status) => status < 500, label: "gateway" },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
