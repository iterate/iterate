import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const common = {
  stage: z.string().min(1),
  accountId: z.string().min(1),
  authDbId: z.string().min(1),
};

export const AlchemyResources = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("auth"), ...common }),
  z.strictObject({
    kind: z.literal("platform"),
    ...common,
    projectDirectoryKvId: z.string().min(1),
    workerBuildCacheKvId: z.string().min(1),
    semaphoreDbId: z.string().min(1),
  }),
]);

export type AlchemyResources = z.infer<typeof AlchemyResources>;

export function alchemyResourcesPath(stage: string) {
  return fileURLToPath(
    new URL(`../../infra/output/${stage}/cloudflare-resources.json`, import.meta.url),
  );
}

export function loadAlchemyResources(stage: string, accountId: string) {
  let resources: AlchemyResources;
  try {
    resources = AlchemyResources.parse(
      JSON.parse(readFileSync(alchemyResourcesPath(stage), "utf8")),
    );
  } catch (error) {
    throw new Error(
      `No valid Alchemy output for ${stage}. Run "pnpm infra deploy --env ${stage}" first.`,
      { cause: error },
    );
  }
  if (resources.stage !== stage || resources.accountId !== accountId) {
    throw new Error(
      `Alchemy output is for ${resources.stage}/${resources.accountId}, not ${stage}/${accountId}.`,
    );
  }
  return resources;
}

export function loadPlatformAlchemyResources(stage: string, accountId: string) {
  const resources = loadAlchemyResources(stage, accountId);
  if (resources.kind !== "platform") {
    throw new Error(`Alchemy output for ${stage} contains only auth resources.`);
  }
  return resources;
}
