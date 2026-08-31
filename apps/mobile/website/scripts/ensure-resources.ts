/**
 * Ensure mobile.iterate.com's resources exist:
 *
 *   pnpm ensure-resources --env prd
 *
 * Idempotent and create-only — it NEVER deletes anything. Two resources:
 * the proxied originless DNS record (worker zone routes only fire when a
 * proxied record answers the hostname) and the name-addressed R2 bucket
 * holding the per-channel "expected native build" snapshots.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { mobileWebsiteEnvs } from "../../../../envs.ts";
import { ensureProxiedDnsRecord } from "../../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../../scripts/lib/env-context.ts";

/** Ensure mobile.iterate.com's DNS record + R2 bucket exist (create-only, idempotent). */
export default async function ensureResources(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const ctx = await resolveEnvContext({
    envs: mobileWebsiteEnvs,
    dopplerProject: "os",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const { env, cf, cfV4 } = ctx;
  console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

  const zones = await cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
  );
  await ensureProxiedDnsRecord(
    ctx,
    zones,
    env.hostname,
    `iterate ${ctx.name} mobile website route host (ensure-resources.ts)`,
  );

  // Same shape as apps/os ensureR2Bucket — inlined rather than importing the
  // kernel's scripts into userland. Name-addressed, no envs.ts id.
  const bucketName = `${env.workerName}-state`;
  const r2 = await cf<{ buckets: { name: string }[] }>(`/r2/buckets?per_page=1000`);
  if (r2.buckets.some((bucket) => bucket.name === bucketName)) {
    console.log(`R2 bucket ${bucketName} exists`);
  } else {
    await cf(`/r2/buckets`, { method: "POST", body: JSON.stringify({ name: bucketName }) });
    console.log(`created R2 bucket ${bucketName}`);
  }
  console.log(`✅ ${ctx.name} resources all present`);
}

void createCli({ ...import.meta, name: "ensure-resources" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
