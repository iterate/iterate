/**
 * Ensure a semaphore environment's Cloudflare resources exist:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Idempotent and create-only — it NEVER deletes anything. It creates the
 * lease-inventory D1 database (`<worker>-resources`) and the proxied DNS
 * record for the env's hostname when missing, then compares reality against
 * the env's `resources` entry in envs.ts and prints the exact snippet to
 * paste when they differ. IDs live in git, so the last step of bringing up
 * a new env is always a reviewed commit.
 *
 * CI never runs this: a deploy with a missing/mismatched ID fails loudly and
 * tells you to run it yourself.
 */
import { semaphoreEnvs } from "../../../envs.ts";
import { ensureD1, ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { reconcileResources } from "../../../scripts/lib/wrangler-config.ts";

const ctx = await resolveEnvContext({ envs: semaphoreEnvs, dopplerProject: "semaphore" });
const { env, cfV4 } = ctx;
console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

// ---- D1: lease inventory ------------------------------------------------------
const db = await ensureD1(ctx, `${env.workerName}-resources`);

// ---- DNS: proxied record for the routed hostname ------------------------------
// The worker zone route only fires when a proxied DNS record answers the
// hostname (create-only; deploys never touch DNS).
const zones = await cfV4<{ id: string; name: string }[]>(
  `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
);
await ensureProxiedDnsRecord(
  ctx,
  zones,
  new URL(env.baseUrl).hostname,
  `iterate ${ctx.name} semaphore worker route host (ensure-resources.ts)`,
);

// ---- Reconcile against envs.ts -----------------------------------------------
reconcileResources(ctx.name, env.resources, { resourcesDbId: db.uuid });
