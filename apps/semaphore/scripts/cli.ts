import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";

import { seedEnvironmentConfigLeases as seedEnvironmentConfigLeasesImpl } from "./seed-environment-config-leases.ts";

type SeedEnvironmentConfigLeasesOptions = {
  /** Semaphore base URL. Defaults to SEMAPHORE_BASE_URL or semaphore.iterate.com. */
  semaphoreBaseUrl?: string;
};

/** Seed environment config lease resources into Semaphore for PR previews. */
export async function seedEnvironmentConfigLeases(
  options: SeedEnvironmentConfigLeasesOptions = {},
) {
  return await seedEnvironmentConfigLeasesImpl(options);
}

if (isMainModule()) {
  const args = process.argv.slice(2);

  void createCli({
    ...import.meta,
    name: "@iterate-com/semaphore",
    jsonInput: "auto",
  }).run({
    argv: args,
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}
