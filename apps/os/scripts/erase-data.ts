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
import {
  ensureR2ObjectExpiryLifecycle,
  PREVIEW_DISPOSABLE_TTL_SECONDS,
  PREVIEW_FILES_OBJECT_EXPIRY,
  PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY,
  SANDBOX_BACKUP_EXPIRY_RULE,
  wipeD1Tables,
} from "../../../scripts/lib/deploy-helpers.ts";
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

  // Delete a batch of items with bounded concurrency and a deadline: this
  // script runs inside the preview-slot cleanup job's 10-MINUTE ceiling, and
  // an e2e-churned search-index bucket holds thousands of objects —
  // one-at-a-time REST deletes blew the ceiling on the first live run
  // (preview_6, 2026-07-14). The API's global rate limit (~1200 req/5min)
  // caps total call volume anyway, so a huge backlog cannot finish in one
  // run by construction: each pass deletes what fits its budget and the next
  // release continues — convergent, never job-killing.
  const deleteAll = async (input: {
    items: readonly string[];
    deadline: number;
    deleteOne: (item: string) => Promise<void>;
  }) => {
    const queue = [...input.items];
    let deleted = 0;
    let failed = 0;
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          if (Date.now() > input.deadline) return;
          // Per-item isolation: one transient DELETE failure must not abort
          // the whole wipe (live preview_1 run: a single object error skipped
          // the entire files bucket). The delete-then-relist loop retries
          // failures naturally on the next pass.
          try {
            await input.deleteOne(item);
            deleted += 1;
          } catch (error) {
            failed += 1;
            if (failed <= 3)
              console.warn(`delete failed (will retry next pass): ${String(error).slice(0, 160)}`);
          }
        }
      }),
    );
    return { deleted, failed };
  };

  // ---- AI Search: delete every per-project instance ---------------------------
  // Instances are born with their project (create saga) and are pure derived
  // state over the corpus bucket — without this step an e2e-heavy slot
  // accumulates hundreds of orphaned instances per lease (observed: 162 from
  // one e2e run). Best-effort: the namespace may not exist on old envs.
  const instanceDeadline = Date.now() + 90_000;
  try {
    let instancesDeleted = 0;
    for (;;) {
      // Explicit page=1 on purpose: cf() fails loudly on implicitly truncated
      // listings, but this delete-then-relist loop consumes one page at a
      // time until the namespace is empty — truncation is the design.
      const instances = await cf<{ id: string }[]>(
        `/ai-search/namespaces/${env.osWorkerName}/instances?per_page=100&page=1`,
      );
      if (instances.length === 0) break;
      const { deleted, failed } = await deleteAll({
        items: instances.map((instance) => instance.id),
        deadline: instanceDeadline,
        deleteOne: async (id) => {
          await cf(`/ai-search/namespaces/${env.osWorkerName}/instances/${id}`, {
            method: "DELETE",
          });
        },
      });
      instancesDeleted += deleted;
      if (failed > 0 && deleted === 0) break; // every delete failing = stop churning
      // Only the DEADLINE ends the pass early: per-item failures with
      // progress keep relisting, so failed items retry THIS run instead of
      // waiting for the next release.
      if (Date.now() > instanceDeadline) {
        console.warn(`AI Search: deadline hit with instances remaining — next release continues`);
        break;
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
  //
  // Preview slots take BOTH disposable buckets off this hot path. The
  // search-index especially is pure derived state that churns to thousands of
  // objects, and walking it with one DELETE per object is the biggest source
  // of the cleanup 429 storm that leaked leases (2026-07-15: 1521 objects).
  // Instead we guarantee each bucket's 3h server-side expiry rule and let
  // Cloudflare GC the objects — releasing the slot immediately. AI Search above
  // has no equivalent (namespace-delete needs an empty namespace), so its
  // per-instance sweep stays — but with R2 off the path it no longer competes
  // for the ~1200 req/5min budget. Any bucket whose rule can't be ensured falls
  // back to being walked as before. Prd always walks (its data has no expiry).
  const searchIndexBucket = `${env.osWorkerName}-search-index`;
  const filesBucket = `${env.osWorkerName}-files`;
  const reapedByLifecycle = new Set<string>();
  if (ctx.name.startsWith("preview")) {
    for (const [bucket, expiry] of [
      [searchIndexBucket, PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY],
      [filesBucket, PREVIEW_FILES_OBJECT_EXPIRY],
    ] as const) {
      try {
        await ensureR2ObjectExpiryLifecycle(ctx, bucket, expiry);
        reapedByLifecycle.add(bucket);
        console.log(`R2 ${bucket}: left to ${expiry.ttlSeconds}s lifecycle expiry, not walked`);
      } catch (error) {
        console.warn(
          `R2 ${bucket} lifecycle ensure failed — falling back to walking it: ${String(error).slice(0, 200)}`,
        );
      }
    }
    // Also self-heal the sandbox backups expiry (3h). ensure-resources sets it
    // too, but CI never runs that, so without this preview sandbox backups keep
    // whatever rule they had (often none → they accumulate forever). We only
    // install the rule; the sandboxes bucket's data is never walked here (its
    // containers own it — see the DO section).
    try {
      await ensureR2ObjectExpiryLifecycle(ctx, `${env.osWorkerName}-sandboxes`, {
        ...SANDBOX_BACKUP_EXPIRY_RULE,
        ttlSeconds: PREVIEW_DISPOSABLE_TTL_SECONDS,
      });
      console.log(
        `R2 ${env.osWorkerName}-sandboxes: backups/ set to ${PREVIEW_DISPOSABLE_TTL_SECONDS}s lifecycle expiry`,
      );
    } catch (error) {
      console.warn(`R2 sandboxes lifecycle ensure failed: ${String(error).slice(0, 200)}`);
    }
  }
  const bucketsToWalk = [searchIndexBucket, filesBucket].filter(
    (bucket) => !reapedByLifecycle.has(bucket),
  );
  for (const bucket of bucketsToWalk) {
    // Per-bucket budget: a churn-refilled search-index must not starve the
    // files pass (Bugbot). 90s each + 90s instances stays well inside the
    // cleanup job's 10-minute ceiling alongside the DO/D1/KV work.
    const bucketDeadline = Date.now() + 90_000;
    try {
      let objectsDeleted = 0;
      for (;;) {
        // Same explicit-page opt-out of cf()'s truncation guard as the
        // instance loop above: delete-then-relist until the bucket is empty.
        const listing = await cf<{ key: string }[]>(
          `/r2/buckets/${bucket}/objects?per_page=1000&page=1`,
        );
        if (listing.length === 0) break;
        const { deleted, failed } = await deleteAll({
          items: listing.map((object) => object.key),
          deadline: bucketDeadline,
          deleteOne: async (key) => {
            await cf(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, {
              method: "DELETE",
            });
          },
        });
        objectsDeleted += deleted;
        if (failed > 0 && deleted === 0) break; // every delete failing = stop churning
        // Deadline is the only early exit — partial failures with progress
        // keep relisting so failed objects retry this run.
        if (Date.now() > bucketDeadline) {
          console.warn(
            `R2 ${bucket}: deadline hit with objects remaining — next release continues`,
          );
          break;
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
