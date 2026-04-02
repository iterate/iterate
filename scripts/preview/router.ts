import { resolve } from "node:path";
import { os } from "@orpc/server";
import { z } from "zod";
import { createSemaphoreClient } from "../../apps/semaphore-contract/src/client.ts";
import { CloudflarePreviewAppSlug, cloudflarePreviewApps } from "./apps.ts";
import {
  cleanupCloudflarePreviewForPullRequest,
  createCloudflarePreviewCleanupInputSchema,
  createCloudflarePreviewSyncInputSchema,
  syncCloudflarePreviewForPullRequest,
} from "./preview.ts";

const env = process.env;

function createPreviewStatusInputSchema(env: NodeJS.ProcessEnv) {
  const semaphoreApiToken =
    env.SEMAPHORE_API_TOKEN?.trim() || env.APP_CONFIG_SHARED_API_SECRET?.trim();
  return z.object({
    semaphoreApiToken: semaphoreApiToken
      ? z.string().trim().min(1).default(semaphoreApiToken)
      : z.string().trim().min(1),
    semaphoreBaseUrl: z.string().trim().url().default("https://semaphore.iterate.com"),
  });
}

function createPreviewSemaphoreClient(input: {
  semaphoreApiToken: string;
  semaphoreBaseUrl: string;
}) {
  const semaphore = createSemaphoreClient({
    apiKey: input.semaphoreApiToken,
    baseURL: input.semaphoreBaseUrl,
  });
  return {
    acquire: ({ leaseMs, type, waitMs }: { leaseMs: number; type: string; waitMs?: number }) =>
      semaphore.resources.acquire({ leaseMs, type, waitMs }),
    release: ({ leaseId, slug, type }: { leaseId: string; slug: string; type: string }) =>
      semaphore.resources.release({ leaseId, slug, type }),
    list: ({ type }: { type: string }) => semaphore.resources.list({ type }),
  };
}

export const router = os.router({
  preview: os.router({
    sync: os
      .input(createCloudflarePreviewSyncInputSchema(env).extend({ app: CloudflarePreviewAppSlug }))
      .meta({
        description:
          "Recreate an app preview for the current pull request and update the sticky GitHub comment",
        default: true,
      })
      .handler(async ({ input, signal }) => {
        const app = cloudflarePreviewApps[input.app];
        const result = await syncCloudflarePreviewForPullRequest({
          ...input,
          appDisplayName: app.displayName,
          appSlug: app.slug,
          createPreviewSemaphoreResourceClient: createPreviewSemaphoreClient,
          dopplerProject: app.dopplerProject,
          env,
          previewResourceType: app.previewResourceType,
          previewTestBaseUrlEnvVar: app.previewTestBaseUrlEnvVar,
          previewTestCommandArgs: app.previewTestCommandArgs,
          signal,
          workingDirectory: resolve(process.cwd(), app.appPath),
        });

        if (!result.ok) {
          throw new Error(result.entry.message ?? `Failed to sync ${app.displayName} preview.`);
        }

        return result;
      }),
    cleanup: os
      .input(
        createCloudflarePreviewCleanupInputSchema(env).extend({ app: CloudflarePreviewAppSlug }),
      )
      .meta({
        description: "Clean up an app preview recorded on the sticky GitHub comment",
      })
      .handler(async ({ input, signal }) => {
        const app = cloudflarePreviewApps[input.app];
        const result = await cleanupCloudflarePreviewForPullRequest({
          ...input,
          appDisplayName: app.displayName,
          appSlug: app.slug,
          createPreviewSemaphoreResourceClient: createPreviewSemaphoreClient,
          dopplerProject: app.dopplerProject,
          env,
          previewResourceType: app.previewResourceType,
          previewTestBaseUrlEnvVar: app.previewTestBaseUrlEnvVar,
          previewTestCommandArgs: app.previewTestCommandArgs,
          signal,
          workingDirectory: resolve(process.cwd(), app.appPath),
        });

        if (!result.ok) {
          throw new Error(
            result.entry?.message ?? `Failed to clean up ${app.displayName} preview.`,
          );
        }

        return result;
      }),
    status: os
      .input(createPreviewStatusInputSchema(env))
      .meta({
        description: "Show preview pool inventory and lease state for all preview-enabled apps",
      })
      .handler(async ({ input }) => {
        const semaphore = createPreviewSemaphoreClient(input);
        const now = Date.now();

        return {
          checkedAt: new Date(now).toISOString(),
          semaphoreBaseUrl: input.semaphoreBaseUrl,
          apps: await Promise.all(
            Object.values(cloudflarePreviewApps).map(async (app) => {
              const resources = await semaphore.list({
                type: app.previewResourceType,
              });
              const available = resources
                .filter((resource) => resource.leaseState === "available")
                .map((resource) => ({
                  slug: resource.slug,
                  lastReleasedAt:
                    resource.lastReleasedAt === null
                      ? null
                      : new Date(resource.lastReleasedAt).toISOString(),
                }));
              const leased = resources
                .filter((resource) => resource.leaseState === "leased")
                .map((resource) => ({
                  slug: resource.slug,
                  leasedUntil:
                    resource.leasedUntil === null
                      ? null
                      : new Date(resource.leasedUntil).toISOString(),
                  expiresInMs: resource.leasedUntil === null ? null : resource.leasedUntil - now,
                  lastAcquiredAt:
                    resource.lastAcquiredAt === null
                      ? null
                      : new Date(resource.lastAcquiredAt).toISOString(),
                }))
                .sort((left, right) => {
                  if (left.leasedUntil === null) return 1;
                  if (right.leasedUntil === null) return -1;
                  return left.leasedUntil.localeCompare(right.leasedUntil);
                });

              return {
                app: app.slug,
                displayName: app.displayName,
                previewResourceType: app.previewResourceType,
                total: resources.length,
                availableCount: available.length,
                leasedCount: leased.length,
                nextLeaseExpiryAt: leased[0]?.leasedUntil ?? null,
                available,
                leased,
              };
            }),
          ),
        };
      }),
  }),
});
