/**
 * Generates apps/streams-example-app/wrangler.jsonc (gitignored) from the
 * root envs.ts.
 *
 * Nobody edits or commits the output: vite.config.ts regenerates it before
 * every dev/build, deploys therefore always see a fresh one, and
 * `pnpm gen:wrangler` refreshes it by hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev; each deployed environment gets an env
 * block expanded from its streamsExampleEnvs entry. The app is workers.dev
 * only: no routes, no DNS, no resources, no secrets. Its one binding is the
 * same-script STREAM Durable Object — the app re-exports apps/os's
 * StreamDurableObject from its own worker entry (src/worker.ts) via the `~`
 * alias, so the class lives in this script.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { streamsExampleEnvs, type StreamsExampleEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/** Binding config identical across local dev and every deployed env. */
function workerBindings() {
  return {
    durable_objects: {
      bindings: [{ name: "STREAM", class_name: "StreamDurableObject" }],
    },
    observability: OBSERVABILITY,
  };
}

function envBlock(env: StreamsExampleEnv) {
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    // The env's only public URL is its workers.dev origin (envs.ts baseUrl).
    workers_dev: true,
    ...workerBindings(),
  };
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  // Env-less service name: wrangler tags every `--env` deploy with
  // `cf:service=<top-level name>`, so a "-dev" suffix here would mis-bucket
  // deployed workers under a fake "dev" service in observability queries.
  name: "streams-example-app",
  main: "./src/worker.ts",
  compatibility_date: "2026-06-17",
  compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
  // No `assets` here: the vite plugin injects the client build's assets
  // config into the OUTPUT wrangler.json (dist/…) that deploys actually use.
  migrations: [{ tag: "v1", new_sqlite_classes: ["StreamDurableObject"] }],
  ...workerBindings(),
  env: Object.fromEntries(
    Object.entries(streamsExampleEnvs).map(([name, env]) => [name, envBlock(env)]),
  ),
};

/** Write wrangler.jsonc (gitignored) if changed — see writeGeneratedWranglerConfig. */
export const writeWranglerConfig = () =>
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/streams-example-app",
    config,
  });

/** Regenerate apps/streams-example-app/wrangler.jsonc from the root envs.ts. */
export default function generateWranglerConfig() {
  console.log(`Wrote ${writeWranglerConfig()}`);
}

// The CLI runs only when invoked directly — deploy.ts and vite.config.ts
// import from this module without triggering a write.
if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) {
  void createCli({ ...import.meta, name: "generate-wrangler-config" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
