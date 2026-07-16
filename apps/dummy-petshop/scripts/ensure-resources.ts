/**
 * Ensure a dummy-petshop environment's one Cloudflare resource exists:
 *
 *   pnpm ensure-resources --env preview_3
 *
 * Idempotent and create-only — it NEVER deletes anything. The app owns no
 * D1/KV (state is one Durable Object), so the only thing to create is the
 * proxied DNS record its worker route needs. CI never runs this; bring-up
 * is a one-time manual step per env.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { dummyPetshopEnvs } from "../../../envs.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/** Ensure apps/dummy-petshop's routed-hostname DNS record exists for an environment (create-only, idempotent). */
export default async function ensureResources(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const ctx = await resolveEnvContext({
    envs: dummyPetshopEnvs,
    dopplerProject: "dummy-petshop",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  console.log(`Ensuring resources for ${ctx.name} in account ${ctx.env.cloudflareAccountId}`);
  // The worker zone route only fires when a proxied DNS record answers the
  // hostname (create-only; deploys never touch DNS).
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  await ensureProxiedDnsRecord(
    ctx,
    zones,
    new URL(ctx.env.baseUrl).hostname,
    `iterate ${ctx.name} dummy-petshop worker route host (ensure-resources.ts)`,
  );
  console.log(`✅ ${ctx.name} resources all present`);
}

if (process.argv[1]?.endsWith("ensure-resources.ts")) {
  void createCli({ ...import.meta, name: "ensure-resources" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
