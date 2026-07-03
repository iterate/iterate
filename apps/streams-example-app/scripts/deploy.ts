/**
 * Deploy apps/streams-example-app (the streams browser playground):
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * workers.dev only — no routes, no DNS, no secrets. Steps, all fail-fast:
 *   1. Adopt the worker's Durable Object migration tag when the script
 *      predates wrangler-managed migrations (alchemy-era scripts have
 *      migration_tag null; deploying tagged migrations over them fails with
 *      CF error 10074 — see adoptDoMigrationTag).
 *   2. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, bindings).
 *   3. `wrangler deploy --config <built config>`.
 *   4. Smoke-probe the deployed health endpoint; exit nonzero unless the env
 *      is actually serving.
 */
import { spawnSync } from "node:child_process";
import { globSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamsExampleEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext({
  envs: streamsExampleEnvs,
  dopplerProject: "streams-example-app",
});
console.log(
  `Deploying apps/streams-example-app to ${ctx.name} (worker ${ctx.env.workerName}, account ${ctx.env.cloudflareAccountId})`,
);

// vite.config.ts regenerates wrangler.jsonc from envs.ts before the
// cloudflare plugin reads it — the build below always sees a fresh config.
await adoptDoMigrationTag();

rmSync(join(APP_ROOT, "dist"), { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build"], { CLOUDFLARE_ENV: ctx.name });

const builtConfigs = globSync("dist/**/wrangler.json", { cwd: APP_ROOT });
if (builtConfigs.length !== 1) {
  throw new Error(
    `Expected exactly one dist/**/wrangler.json from the build, found: ${builtConfigs.join(", ") || "none"}`,
  );
}
const builtConfig = join(APP_ROOT, builtConfigs[0]);

run("pnpm", ["exec", "wrangler", "deploy", "--config", builtConfig], {
  CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
});

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
 * Alchemy-era scripts carry a live Durable Object class but a null
 * migration_tag (alchemy submitted untagged migration steps). Deploying
 * wrangler.jsonc's `migrations: [{tag:"v1", …}]` over such a script fails
 * with CF error 10074. The fix, verified empirically 2026-07-03: a settings
 * PATCH with an empty tagged migration adopts the tag without touching
 * classes. No-op for fresh scripts (absent) and already-adopted ones.
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
