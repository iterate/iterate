/**
 * Deploy apps/os to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every required secret, bake
 *      the static auth JWKS (issuer keys + forge public key), and validate
 *      the exact runtime config with the worker's own zod schema — a config
 *      that would throw on every request fails HERE, not after shipping.
 *   2. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, routes, bindings).
 *   3. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically in the same version as the code (after
 *      adopting the DO migration tag on alchemy-era scripts, and a plain
 *      deploy first when the worker has no DO classes yet — see
 *      deploy-helpers.ts).
 *   4. Smoke-probe the deployed base URL; exit nonzero unless the env is
 *      actually serving.
 *
 * The worker script is never deleted and routes are ensure-only, so a deploy
 * can never strand the env's hostnames (the old zombie-route/522 class).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envs } from "../../../envs.ts";
import {
  adoptDoMigrationTag,
  collectSecrets,
  deployWithSecrets,
  findBuiltWranglerConfig,
  run,
  smoke,
} from "../../../scripts/lib/deploy-helpers.ts";
import {
  assertProvisioned,
  resolveEnvContext,
  type EnvContext,
} from "../../../scripts/lib/env-context.ts";
import { parseConfig } from "../src/config.ts";
import { envShapedVars, OPTIONAL_SECRETS, REQUIRED_SECRETS } from "./generate-wrangler-config.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext({ envs, dopplerProject: "os" });
assertProvisioned(ctx.name, ctx.env.resources);
console.log(
  `Deploying apps/os to ${ctx.name} (worker ${ctx.env.osWorkerName}, account ${ctx.env.cloudflareAccountId})`,
);

// ---- 1. Secrets + config validation -------------------------------------------
const secretValues = collectSecrets(ctx, REQUIRED_SECRETS, OPTIONAL_SECRETS);
// Baked at deploy time, so it's the one secret not in secrets.required.
secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = await bakeStaticAuthJwks(ctx);

// Parse the exact env the worker will see (secrets + generated vars) with
// the worker's own schema — the strongest possible pre-flight.
parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

// ---- 2. Build ----------------------------------------------------------------
// vite.config.ts regenerates wrangler.jsonc from envs.ts before the
// cloudflare plugin reads it — the build below always sees a fresh config.
rmSync(join(APP_ROOT, "dist"), { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build"], { cwd: APP_ROOT, env: { CLOUDFLARE_ENV: ctx.name } });

const builtConfig = findBuiltWranglerConfig(APP_ROOT);

// ---- 3. Deploy (code + secrets in one version) --------------------------------
// os ships the same tagged migrations as the other DO apps — alchemy-era os
// workers with live classes would hit CF 10074 without the tag adoption.
await adoptDoMigrationTag(ctx, ctx.env.osWorkerName);
await deployWithSecrets({
  cwd: APP_ROOT,
  builtConfig,
  secretValues,
  credentials: {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
  },
  ensureClassesFor: { ctx, workerName: ctx.env.osWorkerName },
});

// ---- 4. Smoke ------------------------------------------------------------------
await smoke(
  `${ctx.env.baseUrl}/`,
  (status) => status === 200 || (status >= 300 && status < 400),
  "dashboard",
);
await smoke(`${ctx.env.baseUrl}/api`, (status) => status < 500, "os api");
console.log(`✅ ${ctx.name} deployed and serving at ${ctx.env.baseUrl}`);

/**
 * A static JWKS lets the worker verify auth JWTs without a runtime fetch,
 * and is the only trustworthy carrier for the forge public key (identity
 * minting — scripts/auth/mint-session.ts). An explicit
 * APP_CONFIG_ITERATE_AUTH__JWKS in Doppler wins over the live fetch — the
 * break-glass path for deploying os while the auth worker is down. Forge
 * keys in production-serving configs require the explicit
 * AUTH_FORGE_ALLOW_PRODUCTION opt-in.
 */
async function bakeStaticAuthJwks(ctx: EnvContext<(typeof envs)[keyof typeof envs]>) {
  const issuer = `${ctx.env.authBaseUrl}/api/auth`;

  const pinned = ctx.secrets.APP_CONFIG_ITERATE_AUTH__JWKS?.trim();
  if (pinned) {
    console.warn(
      `Using the JWKS pinned in Doppler (APP_CONFIG_ITERATE_AUTH__JWKS) instead of fetching ${issuer}/jwks.`,
    );
  }
  const jwks = pinned
    ? (JSON.parse(pinned) as { keys: Record<string, unknown>[] })
    : await fetchJwksWithRetry(`${issuer}/jwks`, ctx.name);

  const forgePrivateJwk = ctx.secrets.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (forgePrivateJwk) {
    const isProdServing = ctx.name === "prd" || issuer.includes("auth.iterate.com");
    const allowProduction = /^(1|true|yes)$/i.test(ctx.secrets.AUTH_FORGE_ALLOW_PRODUCTION ?? "");
    if (isProdServing && !allowProduction) {
      throw new Error(
        `AUTH_FORGE_PRIVATE_JWK is present in ${ctx.env.dopplerConfig} (production-serving) without ` +
          "AUTH_FORGE_ALLOW_PRODUCTION=true. Set the flag to deliberately enable production minting, " +
          "or remove the forge key.",
      );
    }
    const { d: _privateKey, ...publicJwk } = JSON.parse(forgePrivateJwk) as Record<
      string,
      unknown
    > & { d?: string };
    if (!publicJwk.kid || !publicJwk.kty)
      throw new Error("AUTH_FORGE_PRIVATE_JWK must be a JWK with kid and kty");
    if (!jwks.keys.some((key) => key.kid === publicJwk.kid)) jwks.keys.push(publicJwk);
  }
  return JSON.stringify(jwks);
}

/** Fetch the auth worker's live JWKS, retrying transient failures 3 times. */
/**
 * Poll the issuer's JWKS for up to ~4 minutes: the preview CI lane deploys
 * auth and os IN PARALLEL, so this env's auth worker may legitimately still
 * be mid-deploy (migrations + build take minutes) when os gets here.
 */
async function fetchJwksWithRetry(url: string, envName: string) {
  const deadline = Date.now() + 4 * 60_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { keys?: Record<string, unknown>[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("JWKS has no keys");
      return body as { keys: Record<string, unknown>[] };
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `Deploy-time JWKS fetch from ${url} kept failing for 4 minutes (last: ${error}). ` +
            `Deploy the auth worker for ${envName} first, or pin APP_CONFIG_ITERATE_AUTH__JWKS in Doppler.`,
        );
      }
      console.warn(
        `JWKS fetch attempt ${attempt} failed (${error}); auth may still be deploying — retrying…`,
      );
      await new Promise((res) => setTimeout(res, Math.min(2000 * attempt, 10_000)));
    }
  }
}
