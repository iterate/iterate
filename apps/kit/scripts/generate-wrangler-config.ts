/**
 * Generates apps/kit/wrangler.jsonc (gitignored) from the production-only
 * kitEnvs map in the root envs.ts. Vite regenerates it before every dev/build.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { kitEnvs, type KitEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

function envBlock(env: KitEnv) {
  const host = new URL(env.baseUrl).hostname;
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    routes: [{ pattern: `${host}/*`, zone_name: host.split(".").slice(1).join(".") }],
    // Keep the explicitly requested kiterate.iterate.workers.dev origin live
    // alongside the friendly k.iterate.com route.
    workers_dev: true,
    observability: OBSERVABILITY,
  };
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "kit",
  main: "@tanstack/react-start/server-entry",
  compatibility_date: "2026-06-17",
  compatibility_flags: ["nodejs_compat"],
  // The Vite plugin injects public/ (including generated firmware binaries)
  // into the built config's assets block.
  observability: OBSERVABILITY,
  env: Object.fromEntries(Object.entries(kitEnvs).map(([name, env]) => [name, envBlock(env)])),
};

export const writeWranglerConfig = () =>
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/kit",
    config,
  });

export default function generateWranglerConfig(options: { env?: string } = {}) {
  if (options.env && !(options.env in kitEnvs)) {
    throw new Error(
      `Unknown env ${JSON.stringify(options.env)}; known envs: ${Object.keys(kitEnvs).join(", ")}`,
    );
  }
  console.log(`Wrote ${writeWranglerConfig()}`);
}

if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) {
  void createCli({ ...import.meta, name: "generate-wrangler-config" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
