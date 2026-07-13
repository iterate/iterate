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
 *     by deploying the parked worker with a `deleted` tombstone for each
 *     live class (the only way to delete DO instances; see
 *     scripts/lib/do-reset.ts). The next deploy — from ANY branch —
 *     recreates exactly the classes its config's `exports` declares, fresh.
 *     Preview slots are deployed by many branches; without this teardown a
 *     handover leaves the previous branch's classes behind. Killing the
 *     instances also stops orphaned scheduler DOs whose alarms kept running
 *     itx scripts (= real LLM spend) against erased projects. Exception:
 *     container-bearing classes (the sandboxes) survive as unreachable
 *     orphans — recreating them is broken upstream (do-reset.ts explains).
 *   - the auth D1 database (identities, orgs, projects — the source of every
 *     project id), by deleting all rows from every table
 *   - the project-directory KV (slug/hostname -> project id cache)
 *
 * The os worker script and its routes stay (deleting a script cascades its
 * routes — the historical zombie-route/522 class), but it serves the parked
 * worker's 503 until the next deploy. The D1 schema and migration history
 * stay intact (rows are deleted, tables kept). NOTE: the auth OAuth clients
 * are data too — redeploy auth for the env afterwards (it re-seeds the OS
 * client) before anyone signs in.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { wipeD1Tables } from "../../../scripts/lib/deploy-helpers.ts";
import { resetWorkerDurableObjects } from "../../../scripts/lib/do-reset.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { COMPATIBILITY_DATE } from "./generate-wrangler-config.ts";

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

  // ---- Durable Objects: destroy every instance --------------------------------
  // First, so no surviving DO (agent turn, scheduler alarm) writes fresh rows
  // into the D1/KV we are about to wipe.
  await resetWorkerDurableObjects({
    ctx,
    workerName: env.osWorkerName,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    credentials: {
      CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: env.cloudflareAccountId,
    },
    compatibilityDate: COMPATIBILITY_DATE,
  });

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

  // ---- AI Search: delete every per-project instance ---------------------------
  // Instances are born with their project (create saga) and are pure derived
  // state over the corpus bucket — without this step an e2e-heavy slot
  // accumulates hundreds of orphaned instances per lease (observed: 162 from
  // one e2e run). Best-effort: the namespace may not exist on old envs.
  try {
    let instancesDeleted = 0;
    for (;;) {
      const instances = await cf<{ id: string }[]>(
        `/ai-search/namespaces/${env.osWorkerName}/instances?per_page=100`,
      );
      if (instances.length === 0) break;
      for (const instance of instances) {
        await cf(`/ai-search/namespaces/${env.osWorkerName}/instances/${instance.id}`, {
          method: "DELETE",
        });
        instancesDeleted += 1;
      }
    }
    console.log(`AI Search: deleted ${instancesDeleted} instances`);
  } catch (error) {
    console.warn(`AI Search instance cleanup skipped: ${String(error).slice(0, 200)}`);
  }

  // ---- R2: wipe the user-content buckets ---------------------------------------
  // The search-index corpus and itx.files store project content; both are
  // user data under this script's contract. (The sandboxes bucket is left
  // alone deliberately — container teardown is broken upstream, see the DO
  // section, and its backups expire on a lifecycle rule.)
  for (const bucket of [`${env.osWorkerName}-search-index`, `${env.osWorkerName}-files`]) {
    try {
      let objectsDeleted = 0;
      for (;;) {
        const listing = await cf<{ key: string }[]>(`/r2/buckets/${bucket}/objects?per_page=1000`);
        if (listing.length === 0) break;
        for (const object of listing) {
          await cf(`/r2/buckets/${bucket}/objects/${encodeURIComponent(object.key)}`, {
            method: "DELETE",
          });
          objectsDeleted += 1;
        }
      }
      console.log(`R2 ${bucket}: deleted ${objectsDeleted} objects`);
    } catch (error) {
      console.warn(`R2 ${bucket} wipe skipped: ${String(error).slice(0, 200)}`);
    }
  }

  console.log(
    `✅ ${ctx.name} data erased: Durable Objects destroyed, D1 and KV wiped; infra intact.`,
  );
  console.log(
    `   The os worker serves 503 until its next deploy. The auth OAuth clients were data too — redeploy auth for ${ctx.name} (it re-seeds the OS client) before signing in.`,
  );
}

void createCli({ ...import.meta, name: "erase-data" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
