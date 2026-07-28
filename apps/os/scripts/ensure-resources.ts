/**
 * Ensure a deployed environment's Cloudflare resources exist:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Idempotent and create-only for data-bearing resources. For each durable
 * resource (the project-directory KV, the auth D1 database, proxied DNS
 * records for every routed hostname) it creates whatever is missing, then
 * compares reality against the env's `resources` entry in envs.ts and prints
 * the exact snippet to paste when they differ. IDs live in git, so the last
 * step of bringing up a new env is always a reviewed commit.
 *
 * CI never runs this: a deploy with a missing/mismatched ID fails loudly and
 * tells you to run it yourself.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import {
  ensureD1,
  ensureProxiedDnsRecord,
  ensureR2ObjectExpiryLifecycle,
  PREVIEW_DISPOSABLE_TTL_SECONDS,
  PREVIEW_FILES_OBJECT_EXPIRY,
  SANDBOX_BACKUP_EXPIRY_RULE,
  SANDBOX_BACKUP_TTL_SECONDS_PRD,
} from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { reconcileResources } from "../../../scripts/lib/wrangler-config.ts";
import { ensureInboundEmailRouting } from "./email-routing-resources.ts";

/**
 * Create-if-missing for one R2 bucket. Exported for deploy.ts prepare():
 * wrangler validates R2 bindings at upload time, so — like the worker events
 * queue — a bound bucket must exist before the deploy, not just after this
 * script has been run by hand. Name-addressed, so no envs.ts ID to reconcile.
 */
export async function ensureR2Bucket(
  cf: <T = unknown>(path: string, init?: RequestInit) => Promise<T>,
  name: string,
): Promise<void> {
  const r2 = await cf<{ buckets: { name: string }[] }>(`/r2/buckets?per_page=1000`);
  if (r2.buckets.some((bucket) => bucket.name === name)) {
    console.log(`R2 bucket ${name} exists`);
    return;
  }
  await cf(`/r2/buckets`, { method: "POST", body: JSON.stringify({ name }) });
  console.log(`created R2 bucket ${name}`);
}

/** Ensure apps/os's Cloudflare resources exist for an environment (create-only, idempotent). */
export default async function ensureResources(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const ctx = await resolveEnvContext({
    envs,
    dopplerProject: "os",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const { env, cf, cfV4 } = ctx;
  console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

  // ---- KV: project directory + worker build cache ---------------------------
  const kvNamespaces = await cf<{ id: string; title: string }[]>(
    `/storage/kv/namespaces?per_page=1000`,
  );
  const ensureKv = async (title: string) => {
    let kv = kvNamespaces.find((namespace) => namespace.title === title);
    if (!kv) {
      kv = await cf<{ id: string; title: string }>(`/storage/kv/namespaces`, {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      console.log(`created KV namespace ${title} (${kv.id})`);
    } else {
      console.log(`KV namespace ${title} exists (${kv.id})`);
    }
    return kv;
  };
  const kv = await ensureKv(`${env.osWorkerName}-project-directory`);
  const buildCacheKv = await ensureKv(`${env.osWorkerName}-worker-build-cache`);

  // ---- R2 buckets ----------------------------------------------------------
  // Sandboxes snapshot /workspace into the `-sandboxes` bucket when they idle
  // out and restore it on the next start (container disk is ephemeral). The
  // `-files` is itx.files project storage. Both are name-addressed, so — unlike
  // KV/D1 — there is nothing to reconcile into envs.ts; create-if-missing is
  // the whole story. Wiping their data is erase-data's / lifecycle's job.
  const isPreview = ctx.name.startsWith("preview");
  const sandboxesBucket = `${env.osWorkerName}-sandboxes`;
  await ensureR2Bucket(cf, sandboxesBucket);
  await ensureR2Bucket(cf, `${env.osWorkerName}-files`);

  // R2 lifecycle: Cloudflare expires objects server-side so cleanup never has
  // to delete them one-by-one — the 429 storm that used to leak preview leases
  // (see erase-data.ts and docs/preview-resource-gc.md). The SDK/worker only
  // CHECK ttls at read/restore time and never delete from R2, so these rules
  // are the actual reaper. PUT replaces each bucket's lifecycle wholesale —
  // fine while these are the only rules per bucket.
  //
  // Preview slots expire everything disposable 3h after last write (synthetic
  // data; pure cost). Prd keeps its data — sandbox backups at 90 days, the
  // project files with no rule at all. A preview sandbox's DO still
  // writes its backup with the 90-day ttl, but this 3h rule deletes it first;
  // restoring a reaped backup degrades to an empty workspace, so the sandbox
  // simply comes back fresh after ~3h of no use.
  await ensureR2ObjectExpiryLifecycle(ctx, sandboxesBucket, {
    ...SANDBOX_BACKUP_EXPIRY_RULE,
    ttlSeconds: isPreview ? PREVIEW_DISPOSABLE_TTL_SECONDS : SANDBOX_BACKUP_TTL_SECONDS_PRD,
  });
  if (isPreview) {
    await ensureR2ObjectExpiryLifecycle(
      ctx,
      `${env.osWorkerName}-files`,
      PREVIEW_FILES_OBJECT_EXPIRY,
    );
  }

  // ---- D1: auth database ------------------------------------------------------
  // apps/auth's ensure-resources also creates this database; both are
  // create-only idempotent, so whichever runs first wins harmlessly.
  const db = await ensureD1(ctx, `${env.authWorkerName}-auth-db`);

  // ---- DNS: proxied records for every routed hostname --------------------------
  // Worker zone routes only fire when a proxied DNS record answers the
  // hostname. Wrangler's custom_domains can't cover wildcards, so ensure the
  // records here (create-only; deploys never touch DNS).
  const hostRecords = [
    new URL(env.baseUrl).hostname,
    new URL(env.eventDocsBaseUrl).hostname,
    new URL(env.mcpBaseUrl).hostname,
    ...env.projectHostnameBases.flatMap((base) => [base, `*.${base}`]),
  ];
  const zones = await cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
  );
  for (const host of hostRecords) {
    await ensureProxiedDnsRecord(
      ctx,
      zones,
      host,
      `iterate ${ctx.name} os worker route host (ensure-resources.ts)`,
    );
  }

  // ---- Email Routing: inbound project email -------------------------------
  // Cloudflare accepts a Worker action only after that script exists. A fresh
  // slot therefore enables routing now and explicitly defers the catch-all;
  // deploy.ts requires and installs it after the first Worker upload.
  await ensureInboundEmailRouting(ctx, {
    projectHostnameBases: env.projectHostnameBases,
    workerName: env.osWorkerName,
    workerRequirement: "allow-missing-before-first-deploy",
  });

  // ---- Reconcile against envs.ts -----------------------------------------------
  reconcileResources(ctx.name, env.resources, {
    projectDirectoryKvId: kv.id,
    workerBuildCacheKvId: buildCacheKv.id,
    authDbId: db.uuid,
  });
}

void createCli({ ...import.meta, name: "ensure-resources" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
