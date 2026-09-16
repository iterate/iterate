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

// The same bindings at the top level (local dev) and in every deployed env.
const bindings = {
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  durable_objects: { bindings: [{ name: "BROWSER_SESSION", class_name: "BrowserSession" }] },
  exports: { BrowserSession: { type: "durable-object", storage: "sqlite" } },
  vars: { ITERATE_ORIGIN: "https://os.iterate2.com" },
  observability: OBSERVABILITY,
  // public/ (the favicon and the synced firmware binaries) is served by the worker's
  // ASSETS fallback; the Vite plugin fills in the built directory.
  assets: { binding: "ASSETS", not_found_handling: "none", run_worker_first: true },
};

function envBlock(env: KitEnv) {
  const host = new URL(env.baseUrl).hostname;
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    routes: [{ pattern: `${host}/*`, zone_name: host.split(".").slice(1).join(".") }],
    // Keep the explicitly requested kiterate.iterate.workers.dev origin live
    // alongside the friendly k.iterate.com route.
    workers_dev: true,
    ...bindings,
  };
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "kit",
  main: "src/worker.ts",
  compatibility_date: "2026-09-01",
  ...bindings,
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
