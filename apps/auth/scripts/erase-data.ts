/**
 * Erase ALL data in a deployed auth environment, leaving its infrastructure
 * (worker, route, DNS, database) untouched:
 *
 *   pnpm erase-data --env preview_3
 *   pnpm erase-data --env prd --yes-i-mean-prd
 *
 * `--env` is mandatory here (no DOPPLER_CONFIG fallback): a destructive
 * script must never pick its target from ambient shell state.
 *
 * Deletes every row of every user table in the auth D1 database (identities,
 * orgs, projects, OAuth clients). The schema and migration history stay
 * intact (rows are deleted, tables kept). NOTE: the OAuth clients are data
 * too — redeploy auth for the env afterwards (its deploy re-seeds them and
 * the bootstrap admin) before anyone signs in. apps/os's erase-data wipes
 * this same database plus os's own resources; use this one when only auth
 * needs a clean slate (e.g. dev_global, which os doesn't deploy to).
 */
import { authEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const ctx = await resolveEnvContext({
  envs: authEnvs,
  dopplerProject: "auth",
  explicitFlagOnly: true,
});
const { env, cf } = ctx;

if (ctx.name === "prd" && !process.argv.includes("--yes-i-mean-prd")) {
  throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
}
console.log(`Erasing all data in ${ctx.name} (auth D1 ${env.resources.authDbId})`);

// ---- auth D1: delete every row of every user table -------------------------
const d1 = (sql: string) =>
  cf<{ results?: { name: string }[]; meta?: { changes?: number } }[]>(
    `/d1/database/${env.resources.authDbId}/query`,
    { method: "POST", body: JSON.stringify({ sql }) },
  );

const tables = (
  await d1(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`,
  )
)[0].results!;

// One request = one session, so the pragma and every DELETE share a
// transaction — FK ordering can't bite and the wipe is atomic.
const wiped = await d1(
  ["PRAGMA defer_foreign_keys = on", ...tables.map((table) => `DELETE FROM "${table.name}"`)].join(
    "; ",
  ),
);
tables.forEach((table, index) => {
  console.log(`auth D1: cleared ${table.name} (${wiped[index + 1]?.meta?.changes ?? "?"} rows)`);
});

console.log(`✅ ${ctx.name} auth data erased. Schema and infra intact.`);
console.log(
  `   Redeploy auth for ${ctx.name} (pnpm run deploy --env ${ctx.name}) to re-seed the bootstrap admin and OAuth clients before signing in.`,
);
