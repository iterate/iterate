import { createCli } from "trpc-cli";
import { voiceEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";

export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: voiceEnvs,
    dopplerProject: "voice",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  await ensureProxiedDnsRecord(ctx, zones, new URL(ctx.env.baseUrl).hostname, "Voice app");
}
if (process.argv[1]?.endsWith("ensure-resources.ts"))
  void createCli({ ...import.meta, name: "ensure-resources" }).run();
