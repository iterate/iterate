/**
 * Deploy apps/semaphore to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every required secret and
 *      validate the exact runtime config with the worker's own zod schema —
 *      a config that would throw on every request fails HERE, not after
 *      shipping.
 *   2. Adopt the worker's Durable Object migration tag when the script
 *      predates wrangler-managed migrations (alchemy-era scripts have
 *      migration_tag null; deploying tagged migrations over them fails with
 *      CF error 10074 — see adoptDoMigrationTag).
 *   3. Apply D1 migrations remotely (wrangler's d1_migrations table, which
 *      the alchemy deploys also used).
 *   4. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, route, bindings).
 *   5. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically in the same version as the code.
 *   6. Smoke-probe the deployed health endpoint; exit nonzero unless the env
 *      is actually serving.
 *
 * CAUTION: semaphore-prd's ResourceCoordinator DO holds the LIVE preview-slot
 * lease state for the whole fleet. Always deploy over it — never delete the
 * worker or erase its Durable Object storage.
 */
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { semaphoreEnvs } from "../../../envs.ts";
import { assertProvisioned, resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { parseConfig } from "../src/config.ts";
import {
  envShapedVars,
  REQUIRED_SECRETS,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext({ envs: semaphoreEnvs, dopplerProject: "semaphore" });
assertProvisioned(ctx.name, ctx.env.resources);
console.log(
  `Deploying apps/semaphore to ${ctx.name} (worker ${ctx.env.workerName}, account ${ctx.env.cloudflareAccountId})`,
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
      `Set them (doppler secrets set --project semaphore --config ${ctx.env.dopplerConfig} ...) and retry.`,
  );
}

// Parse the exact env the worker will see (secrets + generated vars) with
// the worker's own schema — the strongest possible pre-flight.
parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

// ---- 2. DO migration-tag adoption + D1 migrations ------------------------------
// The migrations step below reads wrangler.jsonc directly (and the vite
// build regenerates it again on its own) — write a fresh one now.
writeWranglerConfig();
await adoptDoMigrationTag();
run(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--env",
    ctx.name,
    "--remote",
    "--config",
    "wrangler.jsonc",
  ],
  {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
  },
);

// ---- 3. Build ----------------------------------------------------------------
rmSync(join(APP_ROOT, "dist"), { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build"], { CLOUDFLARE_ENV: ctx.name });

const builtConfigs = globSync("dist/**/wrangler.json", { cwd: APP_ROOT });
if (builtConfigs.length !== 1) {
  throw new Error(
    `Expected exactly one dist/**/wrangler.json from the build, found: ${builtConfigs.join(", ") || "none"}`,
  );
}
const builtConfig = join(APP_ROOT, builtConfigs[0]);

// ---- 4. Deploy (code + secrets in one version) --------------------------------
// Gotcha (observed live 2026-07-03 on os): a worker with NO Durable Object
// classes yet (fresh, or an alchemy-era "parked" placeholder) fails
// `wrangler deploy --secrets-file` with 10061 — initial class migrations
// don't ride that upload path. Plain deploy first to establish classes.
const remoteSettings = await ctx
  .cf<{ bindings?: { type: string }[] }>(`/workers/scripts/${ctx.env.workerName}/settings`)
  .catch(() => null);
if (!remoteSettings?.bindings?.some((binding) => binding.type === "durable_object_namespace")) {
  console.log("Worker has no Durable Object classes yet — plain deploy first to establish them.");
  run("pnpm", ["exec", "wrangler", "deploy", "--config", builtConfig], {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
  });
}

const secretsDir = mkdtempSync(join(tmpdir(), "semaphore-deploy-secrets-"));
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

// ---- 5. Smoke ------------------------------------------------------------------
await smoke(`${ctx.env.baseUrl}/api/__internal/health`, (status) => status === 200, "health");
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
 * Alchemy-era scripts carry live Durable Object classes but a null
 * migration_tag (alchemy submitted untagged migration steps). Deploying
 * wrangler.jsonc's `migrations: [{tag:"v1", …}]` over such a script fails
 * with "Cannot apply new-sqlite-class migration to class … that is already
 * depended on" (code 10074). The fix, verified empirically 2026-07-03: a
 * settings PATCH with an empty tagged migration adopts the tag without
 * touching classes; wrangler then sees old_tag v1 and submits no steps.
 * No-op for fresh scripts (404) and already-adopted ones.
 */
async function adoptDoMigrationTag() {
  const scripts = await ctx.cf<{ id: string; migration_tag: string | null }[]>(
    `/workers/scripts?per_page=1000`,
  );
  const script = scripts.find((candidate) => candidate.id === ctx.env.workerName);
  // Loose != also catches the list endpoint omitting the field (undefined).
  if (!script || script.migration_tag != null) return;
  console.log(`Adopting DO migration tag v1 on ${ctx.env.workerName} (was untagged/alchemy-era)`);
  const form = new FormData();
  form.set("settings", JSON.stringify({ migrations: { new_tag: "v1", steps: [] } }));
  await ctx.cf(`/workers/scripts/${ctx.env.workerName}/settings`, {
    method: "PATCH",
    body: form,
  });
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
