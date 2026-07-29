import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { docsEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

export default async function eraseData(options: {
  /** Required even though this app currently owns no persistent state. */
  env: string;
}) {
  const context = await resolveEnvContext({
    envs: docsEnvs,
    dopplerProject: "docs",
    env: options.env,
  });
  console.log(
    `✅ ${context.name} has no Docs-owned data to erase; workspace files remain owned by OS`,
  );
}

if (process.argv[1]?.endsWith("erase-data.ts")) {
  void createCli({ ...import.meta, name: "erase-data" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
