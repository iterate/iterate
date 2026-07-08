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
import { ensureD1, ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
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
 * Create-if-missing for the deployment's AI Search instance over the search
 * corpus bucket (SPIKE — see domains/search/search-index.ts). Uses the AI
 * Search REST API (https://developers.cloudflare.com/api/resources/ai_search/).
 * Best-effort: instance creation requires a service API token the account
 * token may not be able to mint, and the product is in open beta — a failure
 * prints the manual dashboard recipe and lets the rest of the run proceed.
 */
export async function ensureAiSearchInstance(
  cf: <T = unknown>(path: string, init?: RequestInit) => Promise<T>,
  input: { bucketName: string; instanceName: string },
): Promise<void> {
  try {
    const existing = await cf<{ id?: string; name?: string }[] | null>(
      `/ai-search/instances?per_page=100`,
    );
    const instances = Array.isArray(existing) ? existing : [];
    if (instances.some((instance) => (instance.name ?? instance.id) === input.instanceName)) {
      console.log(`AI Search instance ${input.instanceName} exists`);
      return;
    }
    await cf(`/ai-search/instances`, {
      method: "POST",
      body: JSON.stringify({
        id: input.instanceName,
        name: input.instanceName,
        data_source: { type: "r2", source: input.bucketName },
        // Poll the bucket as often as the product allows; the writers push
        // continuously, so index freshness is bounded by this interval.
        sync_interval: 3600,
      }),
    });
    console.log(`created AI Search instance ${input.instanceName} over ${input.bucketName}`);
  } catch (error) {
    console.warn(
      [
        `Could not create AI Search instance ${input.instanceName} via the API: ${String(error)}`,
        `Create it once in the dashboard instead: AI > AI Search > Create,`,
        `name "${input.instanceName}", data source = R2 bucket "${input.bucketName}",`,
        `default models, then leave everything else as is. itx.search works as`,
        `soon as the first indexing job completes.`,
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

  // ---- R2: sandbox workspace backups --------------------------------------
  // Sandboxes snapshot /workspace into this bucket when they idle out and
  // restore it on the next start (container disk is ephemeral). Addressed by
  // name (`${osWorkerName}-sandboxes`), so — unlike KV/D1 — there is no id to
  // reconcile into envs.ts; create-if-missing is the whole story. Wiping a
  // sandbox's data is erase-data's job, never this create-only script's.
  const r2BucketName = `${env.osWorkerName}-sandboxes`;
  await ensureR2Bucket(cf, r2BucketName);
  // Project file storage (FILES_BUCKET, domains/files/project-files.ts). No
  // lifecycle rule: files live until deleted. Also ensured by deploy.ts
  // prepare() so existing envs pick the bucket up on their next deploy.
  await ensureR2Bucket(cf, `${env.osWorkerName}-files`);
  // The Sandbox SDK checks its backup ttl only at RESTORE time and never
  // deletes expired objects from R2 — without a lifecycle rule the bucket
  // grows forever under e2e churn (a fresh sandbox per test). Expire the
  // SDK's `backups/` prefix at 90 days, matching SANDBOX_BACKUP_TTL_SECONDS
  // in cloudflare-sandbox-durable-object.ts (keep the two aligned). PUT is
  // idempotent; it replaces this bucket's lifecycle config wholesale, which
  // is fine while this is the only rule we want.
  await cf(`/r2/buckets/${r2BucketName}/lifecycle`, {
    method: "PUT",
    body: JSON.stringify({
      rules: [
        {
          id: "expire-sandbox-workspace-backups",
          enabled: true,
          conditions: { prefix: "backups/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * 24 * 60 * 60 } },
        },
      ],
    }),
  });
  console.log(`R2 bucket ${r2BucketName} lifecycle: backups/ expire at 90d`);

  // ---- R2 + AI Search: the itx.search corpus (SPIKE) ----------------------
  // The worker mirrors stream events / itx.files / repo snapshots into this
  // bucket (domains/search/search-index.ts); an AI Search instance named
  // `${osWorkerName}-search` indexes it on a schedule and `itx.search`
  // queries it through the Workers AI binding with per-project folder
  // filters. Instance creation is best-effort: the AI Search REST API is in
  // open beta and creating an instance needs a service API token — when the
  // call fails, this prints the one-time dashboard recipe instead of failing
  // the whole run.
  const searchBucketName = `${env.osWorkerName}-search-index`;
  await ensureR2Bucket(cf, searchBucketName);
  await ensureAiSearchInstance(cf, {
    bucketName: searchBucketName,
    instanceName: `${env.osWorkerName}-search`,
  });

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
