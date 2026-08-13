/**
 * Erase ALL user data in a deployed environment, leaving its infrastructure
 * (workers, routes, DNS, resource IDs) in place:
 *
 *   pnpm erase-data --env preview_3
 *   pnpm erase-data --env prd --yes-i-mean-prd
 *   pnpm erase-data --env prd --yes-i-mean-prd --preserve-auth
 *
 * `--env` is mandatory here (no DOPPLER_CONFIG fallback): a destructive
 * script must never pick its target from ambient shell state.
 *
 * What it destroys and why that's sufficient:
 *   - explicitly retired Worker secret bindings. Wrangler preserves secrets
 *     omitted from a deploy, so a preview slot can otherwise inherit a
 *     forbidden credential from its previous owner. Current secret names are
 *     untouched and the retired names are re-read after deletion.
 *   - every Durable Object on the os worker — instances, storage, alarms —
 *     by deploying the parked worker with a `deleted` tombstone for each
 *     live class (the only way to delete DO instances; see
 *     scripts/lib/do-reset.ts). The next deploy — from ANY branch —
 *     recreates exactly the classes its config's `exports` declares, fresh.
 *     Preview slots are deployed by many branches; without this teardown a
 *     handover leaves the previous branch's classes behind. Killing the
 *     instances also stops orphaned scheduler DOs whose alarms kept running
 *     itx scripts (= real LLM spend) against erased projects. Exception:
 *     container-bearing classes still declared by this branch (the
 *     sandboxes) survive as unreachable orphans — recreating them is broken
 *     upstream. Container applications/classes left by another branch are
 *     retired instead (do-reset.ts explains).
 *   - normally, the auth D1 database (identities, orgs, projects — the source
 *     of every project id) and project-directory KV. `--preserve-auth` keeps
 *     both for a planned production recreation: selected OS projects can then
 *     be created afresh under their exact Auth-owned ids through the normal
 *     project API.
 *
 * The os worker script and its routes stay (deleting a script cascades its
 * routes — the historical zombie-route/522 class), but it serves the parked
 * worker's 503 until the next deploy. The D1 schema and migration history
 * stay intact (rows are deleted, tables kept). Without `--preserve-auth`, the
 * auth OAuth clients are data too, so auth must be redeployed afterwards to
 * re-seed the OS client before anyone signs in.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import {
  ensureR2ObjectExpiryLifecycle,
  PREVIEW_DISPOSABLE_TTL_SECONDS,
  PREVIEW_FILES_OBJECT_EXPIRY,
  removeWorkerSecrets,
  SANDBOX_BACKUP_EXPIRY_RULE,
  wipeD1Tables,
} from "../../../scripts/lib/deploy-helpers.ts";
import { resetWorkerDurableObjects } from "../../../scripts/lib/do-reset.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import {
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SANDBOX_INSTANCE_TYPES,
} from "../src/domains/sandboxes/instance-types.ts";
import { COMPATIBILITY_DATE, RETIRED_WORKER_SECRETS } from "./generate-wrangler-config.ts";

/** Erase ALL user data in a deployed environment; infrastructure stays (see file header). */
export default async function eraseData(options: {
  /** Target environment name from envs.ts. Required — destructive scripts never infer their target. */
  env: string;
  /** Confirm erasing PRODUCTION data (required when --env prd). */
  yesIMeanPrd?: boolean;
  /** Keep Auth D1 and project-directory KV while erasing OS state. */
  preserveAuth?: boolean;
}) {
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const { env, cf } = ctx;

  if (ctx.name === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  }
  console.log(
    `Erasing all data in ${ctx.name} (worker ${env.osWorkerName}, auth D1 ${env.resources.authDbId}, KV ${env.resources.projectDirectoryKvId})`,
  );

  // ---- Retired Worker secrets: remove only the explicit denylist ------------
  // This destructive operator path is the migration boundary. Normal deploys
  // only assert absence and must never mutate credential state.
  await removeWorkerSecrets({
    cf,
    workerName: env.osWorkerName,
    secretNames: RETIRED_WORKER_SECRETS,
  });

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
    containerClassNames: SANDBOX_INSTANCE_TYPES.map(
      (instanceType) => SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className,
    ),
  });

  if (options.preserveAuth) {
    console.log("Auth D1 and project-directory KV preserved for fresh project creation");
  } else {
    // ---- auth D1: delete every row of every user table -----------------------
    await wipeD1Tables(ctx, env.resources.authDbId);

    // ---- project-directory KV: delete every key ------------------------------
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
  }

  // Delete a batch of items with bounded concurrency and a deadline. The API's
  // global rate limit caps total call volume, so each pass deletes what fits
  // its budget and the next release continues.
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
        for (let item = queue.shift(); item; item = queue.shift()) {
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

  // ---- R2: wipe the user-content bucket ----------------------------------------
  // itx.files stores project content. (The sandboxes bucket is left
  // alone deliberately — container teardown is broken upstream, see the DO
  // section, and its backups expire on a lifecycle rule.)
  //
  // Preview slots take the disposable bucket off this hot path. We guarantee
  // its 3h server-side expiry rule and let Cloudflare GC the objects. Any
  // bucket whose rule can't be ensured falls
  // back to being walked as before. Prd always walks (its data has no expiry).
  const filesBucket = `${env.osWorkerName}-files`;
  const reapedByLifecycle = new Set<string>();
  if (ctx.name.startsWith("preview")) {
    for (const [bucket, expiry] of [[filesBucket, PREVIEW_FILES_OBJECT_EXPIRY]] as const) {
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
  const bucketsToWalk = [filesBucket].filter((bucket) => !reapedByLifecycle.has(bucket));
  for (const bucket of bucketsToWalk) {
    // Keep the pass inside the cleanup job's 15-minute ceiling.
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
    options.preserveAuth
      ? `✅ ${ctx.name} OS data erased: Durable Objects and derived/user content destroyed; Auth D1 and project directory preserved.`
      : `✅ ${ctx.name} data erased: Durable Objects destroyed, D1 and KV wiped; infra intact.`,
  );
  console.log(`   The os worker serves 503 until its next deploy.`);
  if (!options.preserveAuth) {
    console.log(
      `   The auth OAuth clients were data too — redeploy auth for ${ctx.name} (it re-seeds the OS client) before signing in.`,
    );
  }
}

void createCli({ ...import.meta, name: "erase-data" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
