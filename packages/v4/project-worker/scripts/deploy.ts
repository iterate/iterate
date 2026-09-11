/**
 * Deploy the isolated v4 proof only after its resources are committed in
 * envs.ts. Secrets are downloaded directly from the dedicated Doppler project
 * into a 0600 temporary file, then code and secrets land in one main-worker
 * version. Aside from Wrangler reconciling this worker's declared routes, the
 * script performs no unrelated resource creation or mutation.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PRD_ACCOUNT_ID, projectV4Envs } from "../../../../envs.ts";
import { appConfigOf } from "../src/app-config.ts";
import { deploymentVars, writeDeploymentConfigs } from "./generate-deploy-config.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const DOPPLER_PROJECT = "project-v4";
const REQUIRED_SECRETS = ["EGRESS_KEY", "EXPERIMENT_ADMIN_TOKEN"] as const;
const DopplerSecrets = z.record(z.string(), z.string());

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function dopplerSecrets(config: string): Record<string, string> {
  const result = spawnSync(
    "doppler",
    [
      "secrets",
      "download",
      "--no-file",
      "--format",
      "json",
      "--project",
      DOPPLER_PROJECT,
      "--config",
      config,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(`Doppler secret download failed for ${DOPPLER_PROJECT}/${config}.`);
  return DopplerSecrets.parse(JSON.parse(result.stdout));
}

function validateEgressKey(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("project-v4/prd EGRESS_KEY must be an unpadded base64url value.");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value)
    throw new Error("project-v4/prd EGRESS_KEY must encode exactly 32 bytes.");
}

const args = process.argv.slice(2);
const envFlag = args.indexOf("--env");
const envName =
  (envFlag >= 0 ? args[envFlag + 1] : undefined) ??
  process.env.npm_config_env ??
  process.env.DOPPLER_CONFIG;
if (envName !== "prd") throw new Error("Usage: pnpm deploy -- --env prd");
const deployment = projectV4Envs.prd;
const secrets = dopplerSecrets(deployment.dopplerConfig);
if (secrets.CLOUDFLARE_ACCOUNT_ID !== PRD_ACCOUNT_ID)
  throw new Error("project-v4/prd does not target the approved production Cloudflare account.");
const missing = REQUIRED_SECRETS.filter((name) => !secrets[name]);
if (missing.length > 0)
  throw new Error(`project-v4/prd is missing required secrets: ${missing.join(", ")}`);
validateEgressKey(secrets.EGRESS_KEY);
if (!secrets.EXPERIMENT_ADMIN_TOKEN.trim())
  throw new Error("project-v4/prd EXPERIMENT_ADMIN_TOKEN must be non-empty.");
// This is the exact non-secret var bundle written into the generated config.
// appConfigOf owns the parser used by the deployed worker, so malformed names
// or maps fail before either Worker can be uploaded.
appConfigOf(deploymentVars(deployment, envName));

run("node", ["build-sdk.mjs"]);
const configs = writeDeploymentConfigs(envName);
const credentials = {
  CLOUDFLARE_ACCOUNT_ID: deployment.cloudflareAccountId,
  CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN,
};
if (!credentials.CLOUDFLARE_API_TOKEN)
  throw new Error("project-v4/prd is missing CLOUDFLARE_API_TOKEN.");

// The sidecar must exist before the main worker declares its service binding.
run("pnpm", ["exec", "wrangler", "deploy", "--config", configs.bundler], credentials);
const secretDirectory = mkdtempSync(join(tmpdir(), "project-v4-secrets-"));
try {
  const secretsFile = join(secretDirectory, "secrets.json");
  writeFileSync(
    secretsFile,
    JSON.stringify(Object.fromEntries(REQUIRED_SECRETS.map((name) => [name, secrets[name]]))),
    { mode: 0o600 },
  );
  run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", configs.main, "--secrets-file", secretsFile],
    credentials,
  );
} finally {
  rmSync(secretDirectory, { recursive: true, force: true });
}

const version = await fetch(`${deployment.publicOrigin}/version`, {
  signal: AbortSignal.timeout(15_000),
});
if (!version.ok) throw new Error(`v4 /version smoke failed: ${version.status}`);
console.log(`✅ ${envName} deployed and /version is healthy at ${deployment.publicOrigin}`);
