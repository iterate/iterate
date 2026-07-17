/**
 * Generates apps/dummy-petshop/wrangler.jsonc (gitignored) from the root
 * envs.ts. Nobody edits or commits the output: deploy.ts and the dev/
 * typecheck scripts regenerate it, and `pnpm gen:wrangler` refreshes it by
 * hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev; each deployed environment gets an env
 * block expanded from its dummyPetshopEnvs entry: one routed hostname
 * (`dummy-petshop.<zone>`, DNS created once by ensure-resources.ts) and one
 * binding — the same-script PETSHOP_STATE Durable Object holding the shop's
 * single state blob. No D1, no KV.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { dummyPetshopEnvs, type DummyPetshopEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/** Binding config identical across local dev and every deployed env. */
function workerBindings() {
  return {
    durable_objects: {
      bindings: [{ name: "PETSHOP_STATE", class_name: "PetshopStateDurableObject" }],
    },
    observability: OBSERVABILITY,
  };
}

function envBlock(env: DummyPetshopEnv) {
  const host = new URL(env.baseUrl).hostname;
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    routes: [{ pattern: `${host}/*`, zone_name: host.replace(/^dummy-petshop\./, "") }],
    // deploy.ts ships PETSHOP_SEAL_KEY with every deploy (Doppler-pinned or
    // deploy-minted); PETSHOP_BACKDOOR_SECRET stays optional.
    secrets: { required: ["PETSHOP_SEAL_KEY"] },
    ...workerBindings(),
  };
}

export function createWranglerConfig(options: { forDeployment?: boolean } = {}) {
  return {
    $schema: "node_modules/wrangler/config-schema.json",
    // Env-less service name: wrangler tags every `--env` deploy with
    // `cf:service=<top-level name>` in observability queries.
    name: "dummy-petshop",
    main: "./src/worker.ts",
    compatibility_date: "2026-06-17",
    // Declarative DO lifecycle — the server reconciles this against live
    // namespaces per deploy, no tag history (see apps/os DO_EXPORTS).
    exports: { PetshopStateDurableObject: { type: "durable-object", storage: "sqlite" } },
    // Local dev seals with a fixed key ("dummy-petshop-local-dev-seal-key"):
    // the shop holds only fake data, and a stable key beats per-run Doppler
    // plumbing. Deployed envs get a real secret via --secrets-file instead,
    // so deployment configs omit the local var rather than triggering
    // Wrangler's correct non-inheritance warning.
    ...(options.forDeployment
      ? {}
      : { vars: { PETSHOP_SEAL_KEY: "ZHVtbXktcGV0c2hvcC1sb2NhbC1kZXYtc2VhbC1rZXk=" } }),
    ...workerBindings(),
    env: Object.fromEntries(
      Object.entries(dummyPetshopEnvs).map(([name, env]) => [name, envBlock(env)]),
    ),
  };
}

export const config = createWranglerConfig();

/** Write wrangler.jsonc (gitignored) if changed — see writeGeneratedWranglerConfig. */
export const writeWranglerConfig = (options: { forDeployment?: boolean } = {}) =>
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/dummy-petshop",
    config: createWranglerConfig(options),
  });

/**
 * Regenerate apps/dummy-petshop/wrangler.jsonc from the root envs.ts.
 *
 * The output always contains every env block (env selection happens at deploy
 * time via Wrangler's `--env`). Passing `--env` validates the name and emits a
 * deployment config without the top-level local-only seal-key var.
 */
export default function generateWranglerConfig(options: { env?: string } = {}) {
  if (options.env && !(options.env in dummyPetshopEnvs)) {
    throw new Error(
      `Unknown env ${JSON.stringify(options.env)}; known envs: ${Object.keys(dummyPetshopEnvs).join(", ")}`,
    );
  }
  console.log(`Wrote ${writeWranglerConfig({ forDeployment: Boolean(options.env) })}`);
}

// The CLI runs only when invoked directly — deploy.ts imports from this
// module without triggering a write.
if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) {
  void createCli({ ...import.meta, name: "generate-wrangler-config" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
