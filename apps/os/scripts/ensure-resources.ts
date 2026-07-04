/**
 * Ensure a deployed environment's Cloudflare resources exist:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Idempotent and create-only — it NEVER deletes anything. For each resource
 * (the project-directory KV, the auth D1 database, proxied DNS records for
 * every routed hostname) it creates whatever is missing, then compares
 * reality against the env's `resources` entry in envs.ts and prints the
 * exact snippet to paste when they differ. IDs live in git, so the last
 * step of bringing up a new env is always a reviewed commit.
 *
 * CI never runs this: a deploy with a missing/mismatched ID fails loudly and
 * tells you to run it yourself.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { ensureD1, ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { reconcileResources } from "../../../scripts/lib/wrangler-config.ts";

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

  // ---- Reconcile against envs.ts -----------------------------------------------
  reconcileResources(ctx.name, env.resources, {
    projectDirectoryKvId: kv.id,
    workerBuildCacheKvId: buildCacheKv.id,
    authDbId: db.uuid,
  });
}

if (process.argv[1]?.endsWith("ensure-resources.ts")) {
  void createCli({ ...import.meta, name: "ensure-resources" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
