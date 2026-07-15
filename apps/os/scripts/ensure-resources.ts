/**
 * Ensure a deployed environment's Cloudflare resources exist:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Idempotent and create-only for data-bearing resources. For each durable
 * resource (the project-directory KV, the auth D1 database, proxied DNS
 * records for every routed hostname) it creates whatever is missing, then
 * compares reality against the env's `resources` entry in envs.ts and prints
 * the exact snippet to paste when they differ. Event-subscription wiring may
 * be recreated to repair destination/source drift; it carries no app data. IDs
 * live in git, so the last step of bringing up a new env is always a reviewed
 * commit.
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
  PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY,
  SANDBOX_BACKUP_TTL_SECONDS_PRD,
} from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { reconcileResources } from "../../../scripts/lib/wrangler-config.ts";
import { emailDomainForDeployment } from "../src/domains/email/utils.ts";
import { ensureWorkerEventQueueResources } from "./event-queue-resources.ts";

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

/**
 * Create-if-missing for the deployment's AI Search NAMESPACE — the container
 * `itx.search` creates per-project instances in at runtime (via the
 * SEARCH_INSTANCES worker binding; see domains/search/search-index.ts).
 * Best-effort: the AI Search management API needs "AI Search Edit" on the
 * token, and each ACCOUNT additionally needs its dashboard-minted service
 * token registered once (AI > AI Search > tokens) before instance creation
 * works — a failure prints the recipe and lets the rest of the run proceed.
 */
export async function ensureAiSearchNamespace(
  cf: <T = unknown>(path: string, init?: RequestInit) => Promise<T>,
  input: { namespaceName: string },
): Promise<void> {
  try {
    const namespaces = await cf<{ name: string }[]>(`/ai-search/namespaces?per_page=100`);
    if (namespaces.some((namespace) => namespace.name === input.namespaceName)) {
      console.log(`AI Search namespace ${input.namespaceName} exists`);
      return;
    }
    await cf(`/ai-search/namespaces`, {
      method: "POST",
      body: JSON.stringify({ name: input.namespaceName }),
    });
    console.log(`created AI Search namespace ${input.namespaceName}`);
  } catch (error) {
    console.warn(
      [
        `Could not ensure AI Search namespace ${input.namespaceName}: ${String(error)}`,
        `Create it once via wrangler: npx wrangler ai-search namespace create ${input.namespaceName}`,
        `(and register the account's AI Search service token in the dashboard first:`,
        `AI > AI Search > tokens). itx.search creates per-project instances at runtime.`,
      ].join("\n"),
    );
  }
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

  // ---- R2 buckets + AI Search namespace -----------------------------------
  // Sandboxes snapshot /workspace into the `-sandboxes` bucket when they idle
  // out and restore it on the next start (container disk is ephemeral). The
  // worker mirrors stream events / itx.files / repo snapshots /
  // itx.search.index() documents into `-search-index`, and itx.search creates
  // ONE AI Search INSTANCE PER PROJECT (structural tenancy) in the deployment's
  // namespace, each indexing only that project's `{projectId}/**` slice.
  // `-files` is itx.files project storage. All are name-addressed, so — unlike
  // KV/D1 — there is nothing to reconcile into envs.ts; create-if-missing is
  // the whole story. Wiping their data is erase-data's / lifecycle's job.
  const isPreview = ctx.name.startsWith("preview");
  const sandboxesBucket = `${env.osWorkerName}-sandboxes`;
  await ensureR2Bucket(cf, sandboxesBucket);
  await ensureR2Bucket(cf, `${env.osWorkerName}-files`);
  await ensureR2Bucket(cf, `${env.osWorkerName}-search-index`);
  await ensureAiSearchNamespace(cf, { namespaceName: env.osWorkerName });

  // R2 lifecycle: Cloudflare expires objects server-side so cleanup never has
  // to delete them one-by-one — the 429 storm that used to leak preview leases
  // (see erase-data.ts and docs/preview-resource-gc.md). The SDK/worker only
  // CHECK ttls at read/restore time and never delete from R2, so these rules
  // are the actual reaper. PUT replaces each bucket's lifecycle wholesale —
  // fine while these are the only rules per bucket.
  //
  // Preview slots expire everything disposable 3h after last write (synthetic
  // data; pure cost). Prd keeps its data — sandbox backups at 90 days, the
  // search corpus + files with no rule at all. A preview sandbox's DO still
  // writes its backup with the 90-day ttl, but this 3h rule deletes it first;
  // restoring a reaped backup degrades to an empty workspace, so the sandbox
  // simply comes back fresh after ~3h of no use.
  await ensureR2ObjectExpiryLifecycle(ctx, sandboxesBucket, {
    ruleId: "expire-sandbox-workspace-backups",
    ttlSeconds: isPreview ? PREVIEW_DISPOSABLE_TTL_SECONDS : SANDBOX_BACKUP_TTL_SECONDS_PRD,
    prefix: "backups/",
  });
  if (isPreview) {
    await ensureR2ObjectExpiryLifecycle(
      ctx,
      `${env.osWorkerName}-search-index`,
      PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY,
    );
    await ensureR2ObjectExpiryLifecycle(
      ctx,
      `${env.osWorkerName}-files`,
      PREVIEW_FILES_OBJECT_EXPIRY,
    );
  }

  // ---- Queues: deployment event queue + Cloudflare Artifacts subscriptions -
  // One general-purpose queue per OS worker. Artifacts event subscriptions are
  // today's producer; future account-level event sources can share the same
  // consumer and dispatch by message shape in src/domains/events.
  await ensureWorkerEventQueueResources(ctx, env.osWorkerName);

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
  // Inbound mail (<slug>@<base>, thread tags <slug>+t<id>@<base>) is delivered
  // to the OS worker's email() handler through a zone catch-all rule. ONLY the
  // first hostname base gets routing: it is the deployment's email domain —
  // the ingress door rejects every other domain and all outbound From/Reply-To
  // addresses are built from it. Enabling Email Routing adds and locks the
  // zone's MX + SPF records; both calls are idempotent. NOTE: Email SENDING
  // (the itx.email outbound half) is onboarded separately in the dashboard —
  // there is no public API for sending onboarding yet.
  const emailBase = emailDomainForDeployment(env.projectHostnameBases);
  const emailZones = emailBase === null ? [] : [emailBase];
  for (const base of emailZones) {
    const zone = zones.find((candidate) => candidate.name === base);
    if (!zone) {
      console.warn(`no zone named ${base} in account ${env.cloudflareAccountId}; skipping email`);
      continue;
    }
    const routing = await cfV4<{ enabled?: boolean }>(`/zones/${zone.id}/email/routing`).catch(
      () => null,
    );
    if (routing?.enabled !== true) {
      await cfV4(`/zones/${zone.id}/email/routing/enable`, { method: "POST", body: "{}" });
      console.log(`enabled Email Routing on ${zone.name}`);
    } else {
      console.log(`Email Routing on ${zone.name} already enabled`);
    }
    await cfV4(`/zones/${zone.id}/email/routing/rules/catch_all`, {
      method: "PUT",
      body: JSON.stringify({
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [env.osWorkerName] }],
        enabled: true,
        name: `${ctx.name} inbound project email (ensure-resources.ts)`,
      }),
    });
    console.log(`Email Routing catch-all on ${zone.name} -> worker ${env.osWorkerName}`);
  }

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
