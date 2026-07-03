/**
 * Deploy apps/auth to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env dev_global
 *   pnpm run deploy --env prd
 *
 * Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every required secret and
 *      compute the derived runtime values (admin allowlist, email OTP flag).
 *   2. Apply D1 migrations remotely, then render + apply the bootstrap-admin
 *      seed SQL (idempotent; the backfill is marker-tracked per pattern).
 *   3. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, route, D1 id, vars).
 *   4. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically in the same version as the code.
 *   5. Smoke-probe the deployed JWKS endpoint; exit nonzero unless the env
 *      is actually serving.
 *   6. Re-seed the declarative OAuth clients from AUTH_SEED_OAUTH_CLIENTS
 *      (Doppler is the source of truth; a no-op when values are unchanged).
 *
 * The worker script is never deleted and routes are ensure-only, so a deploy
 * can never strand the env's hostname (the old zombie-route/522 class).
 */
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authEnvs } from "../../../envs.ts";
import { assertProvisioned, resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import {
  envShapedVars,
  REQUIRED_SECRETS,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";
import { seedOAuthClients } from "./seed-oauth-clients.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Keep in sync with the `adminAllowlist` default in src/config.ts — deploys
// always ship an explicit value so the seed SQL and the runtime agree.
const DEFAULT_ADMIN_ALLOWLIST = "*@nustom.com";

const ctx = await resolveEnvContext({ envs: authEnvs, dopplerProject: "auth" });
assertProvisioned(ctx.name, ctx.env.resources);
console.log(
  `Deploying apps/auth to ${ctx.name} (worker ${ctx.env.authWorkerName}, account ${ctx.env.cloudflareAccountId})`,
);

const cloudflareCredentials = {
  CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
};

// ---- 1. Secrets + derived runtime values ---------------------------------------
const secretValues: Record<string, string> = {};
const missing: string[] = [];
for (const key of REQUIRED_SECRETS) {
  const value = ctx.secrets[key];
  if (value === undefined || value === "") missing.push(key);
  else secretValues[key] = value;
}
if (missing.length > 0) {
  throw new Error(
    `Doppler config ${ctx.env.dopplerConfig} (project auth) is missing required secrets: ${missing.join(", ")}. ` +
      `Set them (doppler secrets set --project auth --config ${ctx.env.dopplerConfig} ...) and retry.`,
  );
}
// Derived: an explicit Doppler value wins; otherwise the platform default.
// Email OTP defaults on for dev-prefixed envs only (dev_global) — it is the
// e2e sign-in lane and must never silently enable itself in prd.
secretValues.APP_CONFIG_ADMIN_ALLOWLIST =
  ctx.secrets.APP_CONFIG_ADMIN_ALLOWLIST ?? DEFAULT_ADMIN_ALLOWLIST;
secretValues.APP_CONFIG_EMAIL_OTP_ENABLED =
  ctx.secrets.APP_CONFIG_EMAIL_OTP_ENABLED?.trim() ||
  (ctx.name.startsWith("dev") ? "true" : "false");
// Base domain project homepages live under. An explicit Doppler value wins;
// otherwise src/config.ts's default applies at runtime.
const projectHostnameBase = ctx.secrets.APP_CONFIG_PROJECT_HOSTNAME_BASE?.trim();
if (projectHostnameBase) secretValues.APP_CONFIG_PROJECT_HOSTNAME_BASE = projectHostnameBase;

// ---- 2. D1 migrations + bootstrap-admin seed ------------------------------------
// The migrations step below reads wrangler.jsonc directly (and the vite
// build regenerates it again on its own) — write a fresh one now.
writeWranglerConfig();
const checkedInConfigArgs = ["--env", ctx.name, "--remote", "--config", "wrangler.jsonc"];
run(
  "pnpm",
  ["exec", "wrangler", "d1", "migrations", "apply", "DB", ...checkedInConfigArgs],
  cloudflareCredentials,
);

// The rendered seed contains a password hash for the bootstrap-admin
// credential account — keep it in a 0700 tmpdir and delete it afterwards.
const seedDir = mkdtempSync(join(tmpdir(), "auth-deploy-seed-"));
try {
  const seedFile = join(seedDir, "admin-seed.sql");
  run("pnpm", ["exec", "tsx", "./scripts/render-admin-seed.ts", seedFile], {
    APP_CONFIG_SERVICE_AUTH_TOKEN: secretValues.APP_CONFIG_SERVICE_AUTH_TOKEN,
    APP_CONFIG_ADMIN_ALLOWLIST: secretValues.APP_CONFIG_ADMIN_ALLOWLIST,
  });
  run(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", ...checkedInConfigArgs, "--file", seedFile, "-y"],
    cloudflareCredentials,
  );
} finally {
  rmSync(seedDir, { recursive: true, force: true });
}

// ---- 3. Build -------------------------------------------------------------------
// The env-shaped vars ride the build environment because Vite statically
// inlines them into the client bundle (vite.config.ts's __AUTH_APP_ORIGIN__
// define; auth-plugins.ts isProduction reads import.meta.env.VITE_APP_STAGE)
// — the runtime bindings alone can't reach it.
rmSync(join(APP_ROOT, "dist"), { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build"], {
  CLOUDFLARE_ENV: ctx.name,
  VITE_APP_STAGE: ctx.name,
  ...envShapedVars(ctx.env),
});

const builtConfigs = globSync("dist/**/wrangler.json", { cwd: APP_ROOT });
if (builtConfigs.length !== 1) {
  throw new Error(
    `Expected exactly one dist/**/wrangler.json from the build, found: ${builtConfigs.join(", ") || "none"}`,
  );
}
const builtConfig = join(APP_ROOT, builtConfigs[0]);

// ---- 4. Deploy (code + secrets in one version) ------------------------------------
const secretsDir = mkdtempSync(join(tmpdir(), "auth-deploy-secrets-"));
try {
  const secretsFile = join(secretsDir, "secrets.json");
  writeFileSync(secretsFile, JSON.stringify(secretValues), { mode: 0o600 });
  run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", builtConfig, "--secrets-file", secretsFile],
    cloudflareCredentials,
  );
} finally {
  rmSync(secretsDir, { recursive: true, force: true });
}

// ---- 5. Smoke ---------------------------------------------------------------------
await smoke(`${ctx.env.authBaseUrl}/api/auth/jwks`, (status) => status === 200, "auth jwks");
console.log(`✅ ${ctx.name} deployed and serving at ${ctx.env.authBaseUrl}`);

// ---- 6. OAuth client seeding (Doppler → DB) ----------------------------------------
if (ctx.secrets.AUTH_SEED_OAUTH_CLIENTS) {
  await seedOAuthClients(
    { ...ctx.secrets, APP_CONFIG_AUTH_APP_ORIGIN: ctx.env.authBaseUrl },
    { baseUrl: ctx.env.authBaseUrl },
  );
}

function run(command: string, args: string[], extraEnv: Record<string, string> = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

async function smoke(url: string, ok: (status: number) => boolean, label: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (ok(response.status)) {
        console.log(`smoke ok: ${label} (${url} → ${response.status})`);
        return;
      }
      console.warn(`smoke attempt ${attempt}: ${label} → ${response.status}`);
    } catch (error) {
      console.warn(`smoke attempt ${attempt}: ${label} → ${error}`);
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(
    `Smoke failed: ${label} (${url}) never answered healthily — the deploy is NOT verified.`,
  );
}
