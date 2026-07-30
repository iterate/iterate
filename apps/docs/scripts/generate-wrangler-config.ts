/**
 * Generate apps/docs/wrangler.jsonc from the root environment map. The
 * output is local-only and regenerated before every Vite dev/build.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { docsEnvs, type DocsEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

export const COMPATIBILITY_DATE = "2026-06-17";

function workerBindings(osBaseUrl: string) {
  return {
    observability: OBSERVABILITY,
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: { OS_BASE_URL: osBaseUrl },
  };
}

function envBlock(env: DocsEnv) {
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    workers_dev: true,
    ...workerBindings(env.osBaseUrl),
  };
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "docs",
  main: "./src/worker.ts",
  compatibility_date: COMPATIBILITY_DATE,
  compatibility_flags: [
    "nodejs_compat",
    "nodejs_compat_populate_process_env",
    "global_fetch_strictly_public",
  ],
  ...workerBindings(process.env.OS_BASE_URL?.trim() || "https://os.iterate.com"),
  env: Object.fromEntries(Object.entries(docsEnvs).map(([name, env]) => [name, envBlock(env)])),
};

export const writeWranglerConfig = () =>
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/docs",
    config,
  });

export default function generateWranglerConfig() {
  console.log(`Wrote ${writeWranglerConfig()}`);
}

if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) {
  void createCli({ ...import.meta, name: "generate-wrangler-config" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
