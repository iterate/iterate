/**
 * Ensure a semaphore environment's Cloudflare resources exist:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Alchemy owns the lease-inventory D1 database. This script retains the
 * proxied DNS record that follows the Worker route configured by Wrangler.
 *
 * Run this explicitly when bringing up a new environment; normal deploys do
 * not mutate DNS.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { semaphoreEnvs } from "../../../envs.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/** Ensure apps/semaphore's Cloudflare resources exist for an environment (create-only, idempotent). */
export default async function ensureResources(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const ctx = await resolveEnvContext({
    envs: semaphoreEnvs,
    dopplerProject: "semaphore",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const { env, cfV4 } = ctx;
  console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

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
}

void createCli({ ...import.meta, name: "ensure-resources" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
