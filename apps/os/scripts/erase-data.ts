/**
 * Erase ALL user data in a deployed environment, leaving its infrastructure
 * (workers, routes, DNS, resource IDs) untouched:
 *
 *   pnpm erase-data --env preview_3
 *   pnpm erase-data --env prd --yes-i-mean-prd
 *
 * `--env` is mandatory here (no DOPPLER_CONFIG fallback): a destructive
 * script must never pick its target from ambient shell state.
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
 * matters; it isn't automated here.
 *
 * The D1 schema and migration history stay intact (rows are deleted, tables
 * kept). NOTE: the auth OAuth clients are data too — redeploy auth for the
 * env afterwards (it re-seeds the OS client) before anyone signs in.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { wipeD1Tables } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/** Erase ALL user data in a deployed environment; infrastructure stays (see file header). */
export default async function eraseData(options: {
  /** Target environment name from envs.ts. Required — destructive scripts never infer their target. */
  env: string;
  /** Confirm erasing PRODUCTION data (required when --env prd). */
  yesIMeanPrd?: boolean;
}) {
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const { env, cf } = ctx;

  if (ctx.name === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  }
  console.log(
    `Erasing all data in ${ctx.name} (auth D1 ${env.resources.authDbId}, KV ${env.resources.projectDirectoryKvId})`,
  );

  // ---- auth D1: delete every row of every user table -------------------------
  await wipeD1Tables(ctx, env.resources.authDbId);

  // ---- project-directory KV: delete every key ---------------------------------
  let deleted = 0;
  for (;;) {
    const keys = await cf<{ name: string }[]>(
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
}

void createCli({ ...import.meta, name: "erase-data" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
