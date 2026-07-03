/**
 * Deploy apps/os to a deployed environment:
 *
 *   pnpm deploy:env --env preview_3
 *   pnpm deploy:env --env prd
 *
 * Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every secret wrangler.jsonc
 *      requires (secrets.required) — plus bake the static auth JWKS
 *      (issuer keys + forge public key) as APP_CONFIG_ITERATE_AUTH__JWKS.
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
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvContext, type EnvContext } from "./lib/env-context.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext();
console.log(
  `Deploying apps/os to ${ctx.name} (worker ${ctx.env.osWorkerName}, account ${ctx.env.cloudflareAccountId})`,
);

// ---- 1. Secrets --------------------------------------------------------------
const requiredSecrets = readRequiredSecretsFromConfig();
const secretValues: Record<string, string> = {};
const missing: string[] = [];
for (const key of requiredSecrets) {
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
secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = await bakeStaticAuthJwks(ctx);

// ---- 2. Build ----------------------------------------------------------------
run("pnpm", ["exec", "tsx", "./scripts/generate-wrangler-config.ts", "--check"]);
run("pnpm", ["exec", "vite", "build"], { CLOUDFLARE_ENV: ctx.name });

const builtConfigs = globSync("dist/**/wrangler.json", { cwd: APP_ROOT });
if (builtConfigs.length !== 1) {
  throw new Error(
    `Expected exactly one dist/**/wrangler.json from the build, found: ${builtConfigs.join(", ") || "none"}`,
  );
}
const builtConfig = join(APP_ROOT, builtConfigs[0]);

// ---- 3. Deploy (code + secrets in one version) --------------------------------
const secretsDir = mkdtempSync(join(tmpdir(), "os-deploy-secrets-"));
const secretsFile = join(secretsDir, "secrets.json");
try {
  writeFileSync(secretsFile, JSON.stringify(secretValues), { mode: 0o600 });
  run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", builtConfig, "--secrets-file", secretsFile],
    {
      CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
    },
  );
} finally {
  rmSync(secretsDir, { recursive: true, force: true });
}

// ---- 4. Smoke ------------------------------------------------------------------
await smoke(`${ctx.env.baseUrl}/`, (status) => status < 500, "dashboard");
await smoke(`${ctx.env.baseUrl}/api/itx`, (status) => status > 0 && status < 500, "itx api");
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

function readRequiredSecretsFromConfig(): string[] {
  // Single source of truth: the generator's output. (Strip the // comment
  // header — the body is plain JSON.)
  const config = JSON.parse(
    readFileSync(join(APP_ROOT, "wrangler.jsonc"), "utf8").replace(/^\/\/.*$/gm, ""),
  );
  return config.secrets.required as string[];
}

/**
 * A static JWKS lets the worker verify auth JWTs without a runtime fetch,
 * and is the only trustworthy carrier for the forge public key (identity
 * minting — scripts/auth/mint-session.ts). Forge keys in production-serving
 * configs require the explicit AUTH_FORGE_ALLOW_PRODUCTION opt-in.
 */
async function bakeStaticAuthJwks(ctx: EnvContext): Promise<string> {
  const issuer = ctx.secrets.APP_CONFIG_ITERATE_AUTH__ISSUER?.replace(/\/+$/, "");
  if (!issuer) throw new Error("APP_CONFIG_ITERATE_AUTH__ISSUER missing from Doppler config.");

  let jwks: { keys: Record<string, unknown>[] } | undefined;
  for (let attempt = 1; attempt <= 3 && !jwks; attempt++) {
    try {
      const response = await fetch(`${issuer}/jwks`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { keys?: Record<string, unknown>[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("JWKS has no keys");
      jwks = body as { keys: Record<string, unknown>[] };
    } catch (error) {
      if (attempt === 3) {
        throw new Error(
          `Deploy-time JWKS fetch from ${issuer} failed after 3 attempts (${error}). ` +
            `Deploy the auth worker for ${ctx.name} first, or fix the issuer in Doppler.`,
        );
      }
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }

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
    if (!jwks!.keys.some((key) => key.kid === publicJwk.kid)) jwks!.keys.push(publicJwk);
  }
  return JSON.stringify(jwks);
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
