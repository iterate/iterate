import { os } from "@orpc/server";
import { createSemaphoreClient } from "@iterate-com/semaphore-contract";
import { createCloudflarePreviewScriptRouter } from "@iterate-com/shared/apps/cloudflare-preview";

export const router = os.router({
  ...createCloudflarePreviewScriptRouter({
    appDisplayName: "Events",
    appSlug: "events",
    createPreviewSemaphoreResourceClient: ({ semaphoreApiToken, semaphoreBaseUrl }) => {
      const semaphore = createSemaphoreClient({
        apiKey: semaphoreApiToken,
        baseURL: semaphoreBaseUrl,
      });
      return {
        acquire: ({ leaseMs, type, waitMs }) =>
          semaphore.resources.acquire({ leaseMs, type, waitMs }),
        release: ({ leaseId, slug, type }) => semaphore.resources.release({ leaseId, slug, type }),
      };
    },
    dopplerProject: "events",
    env: process.env,
    previewResourceType: "events-preview-environment",
    previewTestBaseUrlEnvVar: "EVENTS_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e"],
    workingDirectory: process.cwd(),
  }),
});
