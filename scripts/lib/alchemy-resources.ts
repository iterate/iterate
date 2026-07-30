import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const AlchemyResources = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("auth"),
    authDbId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("platform"),
    authDbId: z.string().min(1),
    projectDirectoryKvId: z.string().min(1),
    workerBuildCacheKvId: z.string().min(1),
    semaphoreDbId: z.string().min(1),
    filesBucketName: z.string().min(1),
    sandboxesBucketName: z.string().min(1),
  }),
]);

export type AlchemyResources = z.infer<typeof AlchemyResources>;

export function alchemyResourcesPath(stage: string) {
  return fileURLToPath(
    new URL(`../../infra/output/${stage}/cloudflare-resources.json`, import.meta.url),
  );
}

export function loadAlchemyResources(stage: string) {
  try {
    return AlchemyResources.parse(JSON.parse(readFileSync(alchemyResourcesPath(stage), "utf8")));
  } catch (error) {
    throw new Error(
      `No valid Alchemy output for ${stage}. Run "pnpm infra deploy --env ${stage}" first.`,
      { cause: error },
    );
  }
}

export function loadPlatformAlchemyResources(stage: string) {
  const resources = loadAlchemyResources(stage);
  if (resources.kind !== "platform") {
    throw new Error(`Alchemy output for ${stage} contains only auth resources.`);
  }
  return resources;
}
