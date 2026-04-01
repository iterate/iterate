import { createSemaphoreClient } from "@iterate-com/semaphore-contract";
import { z } from "zod";

const DEFAULT_PREVIEW_COUNT = 10;
const DEFAULT_SEMAPHORE_BASE_URL = "https://semaphore.iterate.com";

const previewPools = [
  {
    appSlug: "codemode",
    type: "codemode-preview-environment",
  },
  {
    appSlug: "example",
    type: "example-preview-environment",
  },
  {
    appSlug: "events",
    type: "events-preview-environment",
  },
  {
    appSlug: "ingress-proxy",
    type: "ingress-proxy-preview-environment",
  },
  {
    appSlug: "semaphore",
    type: "semaphore-preview-environment",
  },
] as const;

export const SeedCloudflarePreviewEnvironmentPoolInput = z
  .object({
    count: z.coerce.number().int().positive().optional(),
    semaphoreBaseUrl: z.string().trim().url().optional(),
  })
  .default({});

export type SeedCloudflarePreviewEnvironmentPoolInput = z.infer<
  typeof SeedCloudflarePreviewEnvironmentPoolInput
>;

export async function seedCloudflarePreviewEnvironmentPool(
  input: SeedCloudflarePreviewEnvironmentPoolInput,
) {
  const count = input.count ?? DEFAULT_PREVIEW_COUNT;
  const semaphoreBaseUrl =
    input.semaphoreBaseUrl ?? process.env.SEMAPHORE_BASE_URL?.trim() ?? DEFAULT_SEMAPHORE_BASE_URL;
  const semaphoreApiToken =
    process.env.SEMAPHORE_API_TOKEN?.trim() ?? process.env.APP_CONFIG_SHARED_API_SECRET?.trim();
  if (!semaphoreApiToken) {
    throw new Error(
      "SEMAPHORE_API_TOKEN or APP_CONFIG_SHARED_API_SECRET is required to seed preview environments.",
    );
  }

  const semaphore = createSemaphoreClient({
    apiKey: semaphoreApiToken,
    baseURL: semaphoreBaseUrl,
  });

  const summary = [];
  for (const pool of previewPools) {
    const existingResources = await semaphore.resources.list({
      type: pool.type,
    });
    const existingSlugs = new Set(existingResources.map((resource) => resource.slug));
    let addedCount = 0;

    for (let slot = 1; slot <= count; slot += 1) {
      const slug = `${pool.appSlug}-preview-${slot}`;
      if (existingSlugs.has(slug)) {
        continue;
      }

      await semaphore.resources.add({
        type: pool.type,
        slug,
        data: {},
      });
      addedCount += 1;
    }

    summary.push({
      addedCount,
      appSlug: pool.appSlug,
      existingCount: existingResources.length,
      totalCount: existingResources.length + addedCount,
      type: pool.type,
    });
  }

  return {
    count,
    pools: summary,
  };
}
