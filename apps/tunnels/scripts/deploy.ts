/**
 * Deploy apps/tunnels (the captun gateway):
 *
 *   pnpm run deploy --env prd
 *
 * No build step: wrangler bundles the TypeScript entry itself. Secrets ride
 * `wrangler deploy --secrets-file`, so code + secrets land in one version.
 *
 * CAUTION: never delete tunnels-prd. Every dev environment's public tunnels
 * ride it, and force-deleting a worker script CASCADES its zone routes —
 * re-uploading does not bring them back (the zombie-route/522 class). Always
 * deploy over the live worker.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tunnelsEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext({ envs: tunnelsEnvs, dopplerProject: "tunnels" });
console.log(
  `Deploying apps/tunnels to ${ctx.name} (worker ${ctx.env.workerName}, account ${ctx.env.cloudflareAccountId})`,
);

const captunToken = ctx.secrets.CAPTUN_TOKEN;
if (!captunToken) {
  throw new Error(
    `Doppler config ${ctx.env.dopplerConfig} is missing CAPTUN_TOKEN. ` +
      `Set it (doppler secrets set --project tunnels --config ${ctx.env.dopplerConfig} ...) and retry.`,
  );
}

await adoptDoMigrationTag();

const secretsDir = mkdtempSync(join(tmpdir(), "tunnels-deploy-secrets-"));
const secretsFile = join(secretsDir, "secrets.json");
try {
  writeFileSync(secretsFile, JSON.stringify({ CAPTUN_TOKEN: captunToken }), { mode: 0o600 });
  const args = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.jsonc",
    "--env",
    ctx.name,
    "--secrets-file",
    secretsFile,
  ];
  console.log(`$ pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
    },
  });
  if (result.status !== 0) throw new Error(`wrangler deploy exited with ${result.status}`);
} finally {
  rmSync(secretsDir, { recursive: true, force: true });
}

await smoke(`https://${ctx.env.hostname}/`, (status) => status < 500, "gateway");
console.log(`✅ ${ctx.name} deployed and serving at https://${ctx.env.hostname}`);

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
  if (!script || script.migration_tag !== null) return;
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
