import { createSemaphoreTokenProvider } from "../../../scripts/auth/semaphore-token.ts";
import { previewInternals } from "../../../scripts/preview/preview.ts";
import { createSemaphoreClient } from "../src/contract.ts";

const DEFAULT_SEMAPHORE_BASE_URL = "https://semaphore.iterate.com";
const { syncPreviewInventory } = previewInternals;

export type SeedEnvironmentConfigLeasesInput = {
  semaphoreBaseUrl?: string;
};

export async function seedEnvironmentConfigLeases(input: SeedEnvironmentConfigLeasesInput) {
  const semaphoreBaseUrl =
    input.semaphoreBaseUrl?.trim() ||
    process.env.SEMAPHORE_BASE_URL?.trim() ||
    DEFAULT_SEMAPHORE_BASE_URL;
  new URL(semaphoreBaseUrl);

  const semaphore = createSemaphoreClient({
    // SEMAPHORE_API_TOKEN (a pre-minted bearer token), else forge-mint an
    // admin access token from the config's AUTH_FORGE_PRIVATE_JWK.
    apiKey: createSemaphoreTokenProvider({
      baseUrl: semaphoreBaseUrl,
      email: "semaphore-seed@iterate.com",
    }),
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
