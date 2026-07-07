/**
 * Ensure the tunnels gateway's DNS records exist:
 *
 *   pnpm ensure-resources --env prd
 *
 * Idempotent and create-only — it NEVER deletes anything. The gateway needs
 * proxied originless records for its hostname AND the `*.` wildcard (every
 * tunnel lives at `<name>.<hostname>`); worker zone routes only fire when a
 * proxied DNS record answers the hostname. Both records already exist in prd,
 * so this is normally a no-op read.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { tunnelsEnvs } from "../../../envs.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/** Ensure the tunnels gateway's DNS records exist (create-only, idempotent). */
export default async function ensureResources(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const ctx = await resolveEnvContext({
    envs: tunnelsEnvs,
    dopplerProject: "tunnels",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const { env, cfV4 } = ctx;
  console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

  const zones = await cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
  );
  for (const host of [env.hostname, `*.${env.hostname}`]) {
    await ensureProxiedDnsRecord(
      ctx,
      zones,
      host,
      `iterate ${ctx.name} tunnels gateway route host (ensure-resources.ts)`,
    );
  }
  console.log(`✅ ${ctx.name} DNS all present`);
}

void createCli({ ...import.meta, name: "ensure-resources" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
