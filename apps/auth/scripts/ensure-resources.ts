/**
 * Ensure a deployed environment's Cloudflare resources exist for apps/auth:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Idempotent and create-only — it NEVER deletes anything. For each resource
 * (the auth D1 database, a proxied DNS record for the auth hostname) it
 * creates whatever is missing, then compares reality against the env's
 * `resources` entry in envs.ts and prints the exact snippet to paste when
 * they differ. IDs live in git, so the last step of bringing up a new env is
 * always a reviewed commit.
 *
 * CI never runs this: a deploy with a missing/mismatched ID fails loudly and
 * tells you to run it yourself.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { authEnvs } from "../../../envs.ts";
import { ensureD1, ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { reconcileResources } from "../../../scripts/lib/wrangler-config.ts";

/** Ensure apps/auth's Cloudflare resources exist for an environment (create-only, idempotent). */
export default async function ensureResources(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const ctx = await resolveEnvContext({
    envs: authEnvs,
    dopplerProject: "auth",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const { env, cfV4 } = ctx;
  console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

  // ---- D1: auth database --------------------------------------------------------
  const db = await ensureD1(ctx, `${env.authWorkerName}-auth-db`);

  // ---- DNS: proxied record for the auth hostname --------------------------------
  // The Worker zone route only fires when a proxied DNS record answers the
  // hostname, so ensure it here (create-only; deploys never touch DNS).
  const zones = await cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
  );
  await ensureProxiedDnsRecord(
    ctx,
    zones,
    new URL(env.authBaseUrl).hostname,
    `iterate ${ctx.name} auth worker route host (ensure-resources.ts)`,
  );

  // ---- Reconcile against envs.ts -------------------------------------------------
  reconcileResources(ctx.name, env.resources, { authDbId: db.uuid });
}

void createCli({ ...import.meta, name: "ensure-resources" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
