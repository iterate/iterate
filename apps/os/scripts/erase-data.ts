/**
 * Erase ALL user data in a deployed environment, leaving its infrastructure
 * (workers, routes, DNS, resource IDs) in place:
 *
 *   pnpm erase-data --env preview_3
 *   pnpm erase-data --env prd --yes-i-mean-prd
 *
 * `--env` is mandatory here (no DOPPLER_CONFIG fallback): a destructive
 * script must never pick its target from ambient shell state.
 *
 * What it destroys and why that's sufficient:
 *   - every Durable Object on the os worker — instances, storage, alarms —
 *     via a placeholder-script upload whose migration `deleted_classes`es
 *     all live classes (the only control-plane way to delete DO instances;
 *     see scripts/lib/do-migrations.ts). This also resets the worker's DO
 *     migration history, so the next deploy — from ANY branch, with ANY
 *     migration tag history — replays its list onto a clean slate. Preview
 *     slots are deployed by many branches with divergent histories; without
 *     the reset a handover leaves the previous branch's classes+tag behind
 *     and the new branch's deploy dies on API 10074/10061 (observed live
 *     2026-07-08, preview-2 / PR #1747). Killing the instances also stops
 *     orphaned scheduler DOs whose alarms kept running itx scripts (= real
 *     LLM spend) against erased projects.
 *   - the auth D1 database (identities, orgs, projects — the source of every
 *     project id), by deleting all rows from every table
 *   - the project-directory KV (slug/hostname -> project id cache)
 *
 * The os worker script and its routes stay (deleting a script cascades its
 * routes — the historical zombie-route/522 class), but it serves the
 * placeholder's 503 until the next deploy. The D1 schema and migration
 * history stay intact (rows are deleted, tables kept). NOTE: the auth OAuth
 * clients are data too — redeploy auth for the env afterwards (it re-seeds
 * the OS client) before anyone signs in.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { wipeD1Tables } from "../../../scripts/lib/deploy-helpers.ts";
import { resetWorkerDurableObjects } from "../../../scripts/lib/do-migrations.ts";
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
    `Erasing all data in ${ctx.name} (worker ${env.osWorkerName}, auth D1 ${env.resources.authDbId}, KV ${env.resources.projectDirectoryKvId})`,
  );

  // ---- Durable Objects: destroy every instance and reset migration history ----
  // First, so no surviving DO (agent turn, scheduler alarm) writes fresh rows
  // into the D1/KV we are about to wipe.
  await resetWorkerDurableObjects(ctx, env.osWorkerName);

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
    `✅ ${ctx.name} data erased: Durable Objects destroyed (migration history reset), D1 and KV wiped; infra intact.`,
  );
  console.log(
    `   The os worker serves 503 until its next deploy. The auth OAuth clients were data too — redeploy auth for ${ctx.name} (it re-seeds the OS client) before signing in.`,
  );
}

void createCli({ ...import.meta, name: "erase-data" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
