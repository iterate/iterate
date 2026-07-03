/**
 * Erase ALL user data in a deployed environment, leaving its infrastructure
 * (workers, routes, DNS, resource IDs) untouched:
 *
 *   pnpm erase-data --env preview_3
 *   pnpm erase-data --env prd --yes-i-mean-prd
 *
 * What it wipes and why that's sufficient:
 *   - the auth D1 database (identities, orgs, projects — the source of every
 *     project id), by deleting all rows from every table
 *   - the project-directory KV (slug/hostname -> project id cache)
 *
 * Durable Objects are addressed by project id; with the D1 + KV gone, every
 * existing DO instance becomes permanently unreachable (new projects mint
 * fresh random ids), so the environment is logically pristine with zero
 * downtime. Orphaned DO storage lingers and only costs pennies; there is NO
 * Cloudflare control-plane API to delete DO instances or namespaces — the
 * only reclaim path is a `deleted_classes`/re-add migration dance (two
 * deploys, ~30s of DO downtime). Run that occasionally if storage cost ever
 * matters; it isn't automated here yet.
 *
 * The D1 schema and migration history stay intact (rows are deleted, tables
 * kept), so the environment is usable immediately — no redeploy required.
 */
import { resolveEnvContext } from "./lib/env-context.ts";

const ctx = await resolveEnvContext();
const { env, cf } = ctx;

if (ctx.name === "prd" && !process.argv.includes("--yes-i-mean-prd")) {
  throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
}
console.log(
  `Erasing all data in ${ctx.name} (auth D1 ${env.resources.authDbId}, KV ${env.resources.projectDirectoryKvId})`,
);

// ---- auth D1: delete every row of every user table -------------------------
const d1 = async (sql: string): Promise<any[]> =>
  (await cf(`/d1/database/${env.resources.authDbId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  })) as any[];

const tables = (
  await d1(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`,
  )
)[0].results as { name: string }[];

await d1("PRAGMA defer_foreign_keys = on");
for (const { name } of tables) {
  const result = (await d1(`DELETE FROM "${name}"`))[0];
  console.log(`auth D1: cleared ${name} (${result.meta?.changes ?? "?"} rows)`);
}

// ---- project-directory KV: delete every key ---------------------------------
let deleted = 0;
for (;;) {
  const keys: { name: string }[] = await cf(
    `/storage/kv/namespaces/${env.resources.projectDirectoryKvId}/keys?limit=1000`,
  );
  if (keys.length === 0) break;
  await cf(`/storage/kv/namespaces/${env.resources.projectDirectoryKvId}/bulk/delete`, {
    method: "POST",
    body: JSON.stringify(keys.map((key) => key.name)),
  });
  deleted += keys.length;
}
console.log(`KV: deleted ${deleted} keys`);

console.log(
  `✅ ${ctx.name} data erased. Old Durable Objects are unreachable orphans; schema and infra intact.`,
);
console.log(
  `   Note: the auth OAuth clients were data too — redeploy auth for ${ctx.name} (it re-seeds the OS client) before signing in.`,
);
