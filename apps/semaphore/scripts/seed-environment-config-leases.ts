import { z } from "zod";
import { previewInternals } from "../../../scripts/preview/preview.ts";
import { createSemaphoreClient } from "../src/contract.ts";

const DEFAULT_SEMAPHORE_BASE_URL = "https://semaphore.iterate.com";
const { syncPreviewInventory } = previewInternals;

export const SeedEnvironmentConfigLeasesInput = z
  .object({
    semaphoreBaseUrl: z.string().trim().url().optional(),
  })
  .default({});

export type SeedEnvironmentConfigLeasesInput = z.infer<typeof SeedEnvironmentConfigLeasesInput>;

export async function seedEnvironmentConfigLeases(input: SeedEnvironmentConfigLeasesInput) {
  const semaphoreBaseUrl =
    input.semaphoreBaseUrl ?? process.env.SEMAPHORE_BASE_URL?.trim() ?? DEFAULT_SEMAPHORE_BASE_URL;
  const semaphoreApiToken =
    process.env.SEMAPHORE_API_TOKEN?.trim() ?? process.env.APP_CONFIG_SHARED_API_SECRET?.trim();
  if (!semaphoreApiToken) {
    throw new Error(
      "SEMAPHORE_API_TOKEN or APP_CONFIG_SHARED_API_SECRET is required to seed environment config leases.",
    );
  }

  const semaphore = createSemaphoreClient({
    apiKey: semaphoreApiToken,
    baseURL: semaphoreBaseUrl,
  });

  return await syncPreviewInventory({
    client: {
      add: (resource) => semaphore.resources.add(resource),
      delete: ({ slug, type }) => semaphore.resources.delete({ slug, type }),
      list: ({ type }) => semaphore.resources.list({ type }),
    },
  });
}
