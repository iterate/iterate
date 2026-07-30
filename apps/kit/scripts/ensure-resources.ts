import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { kitEnvs } from "../../../envs.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: kitEnvs,
    dopplerProject: "kit",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  console.log(`Ensuring resources for ${ctx.name} in account ${ctx.env.cloudflareAccountId}`);

  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  await ensureProxiedDnsRecord(
    ctx,
    zones,
    new URL(ctx.env.baseUrl).hostname,
    `iterate ${ctx.name} kit worker route host (ensure-resources.ts)`,
  );
  console.log(`✅ ${ctx.name} resources all present`);
}

if (process.argv[1]?.endsWith("ensure-resources.ts")) {
  void createCli({ ...import.meta, name: "ensure-resources" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
