/**
 * Deploy apps/auth to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env dev_global
 *   pnpm run deploy --env prd
 *
 * Runs the shared pipeline (scripts/lib/deploy-app.ts). Steps, all fail-fast:
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { authEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { run } from "../../../scripts/lib/deploy-helpers.ts";
import { DEFAULT_ADMIN_ALLOWLIST } from "../src/config.ts";
import {
  envShapedVars,
  REQUIRED_SECRETS,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";
import { seedOAuthClients } from "./seed-oauth-clients.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Deploy apps/auth to a deployed environment (see scripts/lib/deploy-app.ts for the pipeline). */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  await deployApp({
    appRoot: APP_ROOT,
    appLabel: "apps/auth",
    envs: authEnvs,
    dopplerProject: "auth",
    env: options.env,
    workerName: (env) => env.authWorkerName,
    servingUrl: (env) => env.authBaseUrl,
    // Only auth's own resource: authEnvs spreads the os envs, whose
    // projectDirectoryKvId is not auth's concern.
    resources: (env) => ({ authDbId: env.resources.authDbId }),
    requiredSecrets: REQUIRED_SECRETS,
    // auth has no Durable Object classes.
    hasDurableObjects: false,
    prepare: (ctx, secretValues, credentials) => {
      // ---- Derived runtime values ------------------------------------------
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

      // ---- D1 migrations + bootstrap-admin seed ----------------------------
      // The migrations step below reads wrangler.jsonc directly (and the vite
      // build regenerates it again on its own) — write a fresh one now.
      writeWranglerConfig();
      const checkedInConfigArgs = ["--env", ctx.name, "--remote", "--config", "wrangler.jsonc"];
      run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", ...checkedInConfigArgs], {
        cwd: APP_ROOT,
        env: credentials,
      });

      // The rendered seed contains a password hash for the bootstrap-admin
      // credential account — keep it in a 0700 tmpdir and delete it afterwards.
      const seedDir = mkdtempSync(join(tmpdir(), "auth-deploy-seed-"));
      try {
        const seedFile = join(seedDir, "admin-seed.sql");
        run("pnpm", ["exec", "tsx", "./scripts/render-admin-seed.ts", seedFile], {
          cwd: APP_ROOT,
          env: {
            APP_CONFIG_SERVICE_AUTH_TOKEN: secretValues.APP_CONFIG_SERVICE_AUTH_TOKEN,
            APP_CONFIG_ADMIN_ALLOWLIST: secretValues.APP_CONFIG_ADMIN_ALLOWLIST,
          },
        });
        run(
          "pnpm",
          [
            "exec",
            "wrangler",
            "d1",
            "execute",
            "DB",
            ...checkedInConfigArgs,
            "--file",
            seedFile,
            "-y",
          ],
          { cwd: APP_ROOT, env: credentials },
        );
      } finally {
        rmSync(seedDir, { recursive: true, force: true });
      }
    },
    // The env-shaped vars ride the build environment because Vite statically
    // inlines them into the client bundle (vite.config.ts's __AUTH_APP_ORIGIN__
    // define; auth-plugins.ts isProduction reads import.meta.env.VITE_APP_STAGE)
    // — the runtime bindings alone can't reach it.
    buildEnv: (ctx) => ({ VITE_APP_STAGE: ctx.name, ...envShapedVars(ctx.env) }),
    smokes: (env) => [
      {
        url: `${env.authBaseUrl}/api/auth/jwks`,
        ok: (status) => status === 200,
        label: "auth jwks",
      },
    ],
    // ---- OAuth client seeding (Doppler → DB) --------------------------------
    afterDeploy: async (ctx) => {
      if (ctx.secrets.AUTH_SEED_OAUTH_CLIENTS) {
        await seedOAuthClients(
          { ...ctx.secrets, APP_CONFIG_AUTH_APP_ORIGIN: ctx.env.authBaseUrl },
          { baseUrl: ctx.env.authBaseUrl },
        );
      }
    },
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
