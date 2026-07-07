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
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { authEnvs } from "../../../envs.ts";
import { wipeD1Tables } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/** Erase ALL data in a deployed auth environment; infrastructure stays (see file header). */
export default async function eraseData(options: {
  /** Target environment name from envs.ts. Required — destructive scripts never infer their target. */
  env: string;
  /** Confirm erasing PRODUCTION data (required when --env prd). */
  yesIMeanPrd?: boolean;
}) {
  const ctx = await resolveEnvContext({
    envs: authEnvs,
    dopplerProject: "auth",
    env: options.env,
  });
  const { env } = ctx;

  if (ctx.name === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  }
  console.log(`Erasing all data in ${ctx.name} (auth D1 ${env.resources.authDbId})`);

  // ---- auth D1: delete every row of every user table -------------------------
  await wipeD1Tables(ctx, env.resources.authDbId);

  console.log(`✅ ${ctx.name} auth data erased. Schema and infra intact.`);
  console.log(
    `   Redeploy auth for ${ctx.name} (pnpm run deploy --env ${ctx.name}) to re-seed the bootstrap admin and OAuth clients before signing in.`,
  );
}

void createCli({ ...import.meta, name: "erase-data" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
