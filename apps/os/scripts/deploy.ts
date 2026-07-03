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
 *      secrets land atomically in the same version as the code.
 *   4. Smoke-probe the deployed base URL; exit nonzero unless the env is
 *      actually serving.
 *
 * The worker script is never deleted and routes are ensure-only, so a deploy
 * can never strand the env's hostnames (the old zombie-route/522 class).
 */
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envs } from "../../../envs.ts";
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
const secretValues: Record<string, string> = {};
const missing: string[] = [];
for (const key of REQUIRED_SECRETS) {
  const value = ctx.secrets[key];
  if (value === undefined || value === "") missing.push(key);
  else secretValues[key] = value;
}
if (missing.length > 0) {
  throw new Error(
    `Doppler config ${ctx.env.dopplerConfig} is missing required secrets: ${missing.join(", ")}. ` +
      `Set them (doppler secrets set --config ${ctx.env.dopplerConfig} ...) and retry.`,
  );
}
for (const key of OPTIONAL_SECRETS) {
  const value = ctx.secrets[key];
  if (value) secretValues[key] = value;
}
// Baked at deploy time, so it's the one secret not in secrets.required.
secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = await bakeStaticAuthJwks(ctx);

// Parse the exact env the worker will see (secrets + generated vars) with
// the worker's own schema — the strongest possible pre-flight.
parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

// ---- 2. Build ----------------------------------------------------------------
// vite.config.ts regenerates wrangler.jsonc from envs.ts before the
// cloudflare plugin reads it — the build below always sees a fresh config.
rmSync(join(APP_ROOT, "dist"), { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build"], { CLOUDFLARE_ENV: ctx.name });

const builtConfigs = globSync("dist/**/wrangler.json", { cwd: APP_ROOT });
if (builtConfigs.length !== 1) {
  throw new Error(
    `Expected exactly one dist/**/wrangler.json from the build, found: ${builtConfigs.join(", ") || "none"}`,
  );
}
const builtConfig = join(APP_ROOT, builtConfigs[0]);

// ---- 3. Deploy (code + secrets in one version) --------------------------------
// Gotcha (observed live 2026-07-03): when the target worker has NO Durable
// Object classes yet (fresh worker, or an alchemy-era "parked" placeholder),
// `wrangler deploy --secrets-file` fails with 10061 — the initial class
// migrations don't make it into that upload path. A plain deploy first
// establishes the classes (existing secrets are preserved across versions),
// then the secrets deploy lands code+secrets atomically as usual.
const cfEnv = {
  CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
};
const remote = await ctx
  .cf<{ bindings?: { type: string }[] }>(`/workers/scripts/${ctx.env.osWorkerName}/settings`)
  .catch(() => null);
if (!remote?.bindings?.some((binding) => binding.type === "durable_object_namespace")) {
  console.log("Worker has no Durable Object classes yet — plain deploy first to establish them.");
  run("pnpm", ["exec", "wrangler", "deploy", "--config", builtConfig], cfEnv);
}

const secretsDir = mkdtempSync(join(tmpdir(), "os-deploy-secrets-"));
const secretsFile = join(secretsDir, "secrets.json");
try {
  writeFileSync(secretsFile, JSON.stringify(secretValues), { mode: 0o600 });
  run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", builtConfig, "--secrets-file", secretsFile],
    cfEnv,
  );
} finally {
  rmSync(secretsDir, { recursive: true, force: true });
}

// ---- 4. Smoke ------------------------------------------------------------------
await smoke(
  `${ctx.env.baseUrl}/`,
  (status) => status === 200 || (status >= 300 && status < 400),
  "dashboard",
);
await smoke(`${ctx.env.baseUrl}/api`, (status) => status < 500, "os api");
console.log(`✅ ${ctx.name} deployed and serving at ${ctx.env.baseUrl}`);

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

async function fetchJwksWithRetry(url: string, envName: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { keys?: Record<string, unknown>[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("JWKS has no keys");
      return body as { keys: Record<string, unknown>[] };
    } catch (error) {
      if (attempt === 3) {
        throw new Error(
          `Deploy-time JWKS fetch from ${url} failed after 3 attempts (${error}). ` +
            `Deploy the auth worker for ${envName} first, or pin APP_CONFIG_ITERATE_AUTH__JWKS in Doppler.`,
        );
      }
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
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
