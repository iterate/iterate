/**
 * Ensure a deployed environment's Cloudflare resources exist for apps/auth:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Idempotent and create-only — it NEVER deletes anything. For each resource
 * (the auth D1 database, a proxied DNS record for the auth hostname) it
 * creates whatever is missing, then compares reality against the env's
 * `resources` entry in envs.ts and prints the exact snippet to paste when
 * they differ. IDs live in git, so the last step of bringing up a new env is
 * always a reviewed commit.
 *
 * CI never runs this: a deploy with a missing/mismatched ID fails loudly and
 * tells you to run it yourself.
 */
import { authEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const ctx = await resolveEnvContext({ envs: authEnvs, dopplerProject: "auth" });
const { env, cf, cfV4 } = ctx;
console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

// ---- D1: auth database --------------------------------------------------------
const dbName = `${env.authWorkerName}-auth-db`;
const databases = await cf<{ uuid: string; name: string }[]>(`/d1/database?per_page=1000`);
let db = databases.find((database) => database.name === dbName);
if (!db) {
  db = await cf<{ uuid: string; name: string }>(`/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name: dbName }),
  });
  console.log(`created D1 database ${dbName} (${db.uuid})`);
} else {
  console.log(`D1 database ${dbName} exists (${db.uuid})`);
}

// ---- DNS: proxied record for the auth hostname --------------------------------
// The Worker zone route only fires when a proxied DNS record answers the
// hostname, so ensure it here (create-only; deploys never touch DNS).
const authHost = new URL(env.authBaseUrl).hostname;
const zones = await cfV4<{ id: string; name: string }[]>(
  `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
);
const zone = zones.find(
  (candidate) => authHost === candidate.name || authHost.endsWith(`.${candidate.name}`),
);
if (!zone) {
  console.warn(`⚠ no zone for ${authHost} in this account — create the zone first, then re-run`);
} else {
  // Any record type counts as "exists" — create-only means we never fight
  // an operator's hand-made record.
  const existing = await cfV4<unknown[]>(
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(authHost)}&per_page=5`,
  );
  if (existing.length > 0) {
    console.log(`DNS record for ${authHost} exists`);
  } else {
    await cfV4(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "AAAA",
        name: authHost,
        content: "100::", // originless: traffic terminates at the Worker route
        proxied: true,
        comment: `iterate ${ctx.name} auth worker route host (ensure-resources.ts)`,
      }),
    });
    console.log(`created proxied DNS record for ${authHost}`);
  }
}

// ---- Reconcile against envs.ts -------------------------------------------------
if (env.resources.authDbId !== db.uuid) {
  console.log(
    `\nenvs.ts is out of date for ${ctx.name} — set in its resources entry:\n\n` +
      `  authDbId: "${db.uuid}",\n`,
  );
  console.log("then commit and regenerate: pnpm gen:wrangler");
  process.exit(1);
}
console.log(`✅ ${ctx.name} resources all present and match envs.ts`);
