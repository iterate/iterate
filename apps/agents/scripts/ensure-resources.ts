import { createCli } from "trpc-cli";
import { agentsEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";

export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: agentsEnvs,
    dopplerProject: "agents",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  await ensureProxiedDnsRecord(ctx, zones, new URL(ctx.env.baseUrl).hostname, "Agents app");
}
if (process.argv[1]?.endsWith("ensure-resources.ts"))
  void createCli({ ...import.meta, name: "ensure-resources" }).run();
