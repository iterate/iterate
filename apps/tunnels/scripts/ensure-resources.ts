import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { tunnelsEnvs } from "../../../envs.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/** Ensure the proxied apex and wildcard records that the Captun routes require. */
export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: tunnelsEnvs,
    dopplerProject: "tunnels",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  for (const hostname of [ctx.env.hostname, `*.${ctx.env.hostname}`])
    await ensureProxiedDnsRecord(ctx, zones, hostname, "Tunnels gateway");
  console.log(`✅ ${ctx.name} tunnel DNS records are present`);
}

if (process.argv[1]?.endsWith("ensure-resources.ts")) {
  void createCli({ ...import.meta, name: "ensure-resources" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
