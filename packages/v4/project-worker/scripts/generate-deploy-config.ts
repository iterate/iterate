/**
 * Expand the one approved v4 deployment entry in envs.ts into two disposable
 * Wrangler configs. The handwritten wrangler.jsonc files remain local-dev
 * inputs; deploy never mutates or relies on them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRD_ACCOUNT_ID,
  UNPROVISIONED,
  projectV4Envs,
  type ProjectV4Env,
} from "../../../../envs.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = resolve(appRoot, ".wrangler", "prd");
const REQUIRED_SECRETS = ["EGRESS_KEY", "EXPERIMENT_ADMIN_TOKEN"];

export function writeDeploymentConfigs(envName: string): { bundler: string; main: string } {
  if (envName !== "prd")
    throw new Error(`Unknown v4 environment ${JSON.stringify(envName)}; only prd is configured.`);
  const env = projectV4Envs.prd satisfies ProjectV4Env;
  if (env.cloudflareAccountId !== PRD_ACCOUNT_ID)
    throw new Error("The v4 namespace is approved only in the production Cloudflare account.");
  const missing = Object.entries(env.resources).filter(([, id]) => id === UNPROVISIONED);
  if (missing.length > 0)
    throw new Error(
      `v4 ${envName} resources are unprovisioned: ${missing.map(([name]) => name).join(", ")}. ` +
        "Provision the isolated namespaces and replace the UNPROVISIONED ids in envs.ts before deploy.",
    );

  mkdirSync(outputDirectory, { recursive: true });
  const common = {
    account_id: env.cloudflareAccountId,
    compatibility_date: "2026-09-01",
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
      traces: { enabled: true, head_sampling_rate: 1, persist: true },
    },
    workers_dev: false,
  };
  const main = {
    $schema: "node_modules/wrangler/config-schema.json",
    ...common,
    name: env.workerName,
    main: resolve(appRoot, "src/worker.ts"),
    compatibility_flags: ["allow_irrevocable_stub_storage"],
    routes: env.routes,
    assets: { directory: resolve(appRoot, "public"), binding: "ASSETS" },
    ai: { binding: "AI" },
    worker_loaders: [{ binding: "LOADER" }],
    version_metadata: { binding: "CF_VERSION_METADATA" },
    durable_objects: {
      bindings: [{ name: "ITERATE_CONTEXT", class_name: "IterateContextDurableObject" }],
    },
    exports: { IterateContextDurableObject: { type: "durable-object", storage: "sqlite" } },
    services: [
      { binding: "BUNDLER", service: env.bundlerWorkerName },
      { binding: "FALLBACK", service: env.workerName, entrypoint: "DummyControlPlane" },
    ],
    kv_namespaces: [
      { binding: "OAUTH_KV", id: env.resources.oauthKvId },
      { binding: "ITX_KV", id: env.resources.itxKvId },
      { binding: "SECRETS_KV", id: env.resources.secretsKvId },
    ],
    vars: deploymentVars(env, envName),
    secrets: { required: REQUIRED_SECRETS },
  };
  const bundler = {
    $schema: "node_modules/wrangler/config-schema.json",
    ...common,
    name: env.bundlerWorkerName,
    main: resolve(appRoot, "src/bundler.ts"),
    compatibility_flags: ["nodejs_compat"],
    define: { "process.browser": "true" },
    kv_namespaces: [{ binding: "BUILD_CACHE", id: env.resources.buildCacheKvId }],
    version_metadata: { binding: "VERSION" },
  };
  const mainPath = resolve(outputDirectory, "main.wrangler.jsonc");
  const bundlerPath = resolve(outputDirectory, "bundler.wrangler.jsonc");
  writeFileSync(mainPath, `${JSON.stringify(main, null, 2)}\n`);
  writeFileSync(bundlerPath, `${JSON.stringify(bundler, null, 2)}\n`);
  return { main: mainPath, bundler: bundlerPath };
}

/** The public and APP_CONFIG variables that the deployed main worker receives. */
export function deploymentVars(env: ProjectV4Env, envName: string) {
  return {
    PUBLIC_ORIGIN: env.publicOrigin,
    APP_CONFIG_ENVIRONMENT_NAME: envName,
    APP_CONFIG_PROJECT_HOSTNAME_BASE: env.projectHostnameBase,
    APP_CONFIG_PROJECTS_JSON: JSON.stringify(env.projects),
    APP_CONFIG_CUSTOM_HOSTNAMES_JSON: JSON.stringify(env.customHostnames),
  };
}

if (process.argv[1]?.endsWith("generate-deploy-config.ts")) {
  const env = process.argv[2] ?? "prd";
  const paths = writeDeploymentConfigs(env);
  console.log(`Wrote ${paths.bundler} and ${paths.main}`);
}
