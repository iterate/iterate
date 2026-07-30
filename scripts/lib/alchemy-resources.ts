import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AlchemyResources } from "../../apps/env-manager/src/state.ts";

export function alchemyResourcesPath(stage: string) {
  return fileURLToPath(
    new URL(
      `../../apps/env-manager/.alchemy/output/${stage}/cloudflare-resources.json`,
      import.meta.url,
    ),
  );
}

export function loadAlchemyResources(stage: string) {
  try {
    const resources = AlchemyResources.parse(
      JSON.parse(readFileSync(alchemyResourcesPath(stage), "utf8")),
    );
    if (resources.stage !== stage) {
      throw new Error(
        `Alchemy output stage ${JSON.stringify(resources.stage)} does not match ${JSON.stringify(stage)}.`,
      );
    }
    return resources;
  } catch (error) {
    throw new Error(
      `No valid Alchemy output for ${stage}. Run "pnpm infra deploy --env ${stage}" first.`,
      { cause: error },
    );
  }
}

export function loadPlatformAlchemyResources(stage: string) {
  const resources = loadAlchemyResources(stage);
  if (resources.kind === "auth") {
    throw new Error(`Alchemy output for ${stage} contains only auth resources.`);
  }
  return resources;
}
