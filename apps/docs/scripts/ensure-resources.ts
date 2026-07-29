import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { docsEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

export default async function ensureResources(
  options: {
    /** Target from docsEnvs; falls back to DOPPLER_CONFIG in CI. */
    env?: string;
  } = {},
) {
  const context = await resolveEnvContext({
    envs: docsEnvs,
    dopplerProject: "docs",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  console.log(
    `✅ ${context.name} needs no app-owned Cloudflare resources (account ${context.env.cloudflareAccountId})`,
  );
}

if (process.argv[1]?.endsWith("ensure-resources.ts")) {
  void createCli({ ...import.meta, name: "ensure-resources" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
