import { os } from "@orpc/server";
import { z } from "zod";
import { createSemaphoreClient } from "../../apps/semaphore-contract/src/client.ts";
import { ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE } from "./preview-inventory.ts";
import {
  cleanupCloudflarePreviewForPullRequest,
  createCloudflarePreviewCleanupInputSchema,
  createCloudflarePreviewSyncInputSchema,
  createCloudflarePreviewTestInputSchema,
  deployCloudflarePreviewForPullRequest,
  syncCloudflarePreviewForPullRequest,
  testCloudflarePreviewForPullRequest,
} from "./preview.ts";
import { reconcileEnvironmentConfigLeaseResources } from "./reconcile-environment-config-leases.ts";

const env = process.env;
const previewBoundaryEnv = createPreviewBoundaryEnv(env);

function createPreviewBoundaryEnv(env: NodeJS.ProcessEnv) {
  return {
    ...env,
    SEMAPHORE_API_TOKEN: resolvePreviewSemaphoreApiToken(env),
  };
}

function resolvePreviewSemaphoreApiToken(env: NodeJS.ProcessEnv) {
  return env.SEMAPHORE_API_TOKEN?.trim() || env.APP_CONFIG_SHARED_API_SECRET?.trim();
}

function createPreviewStatusInputSchema(env: NodeJS.ProcessEnv) {
  const semaphoreApiToken = resolvePreviewSemaphoreApiToken(env);
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
    acquireSpecific: ({ leaseMs, slug, type }: { leaseMs: number; slug: string; type: string }) =>
      semaphore.resources.acquireSpecific({ leaseMs, slug, type }),
    renew: ({
      leaseId,
      leaseMs,
      slug,
      type,
    }: {
      leaseId: string;
      leaseMs: number;
      slug: string;
      type: string;
    }) => semaphore.resources.renew({ leaseId, leaseMs, slug, type }),
    release: ({ leaseId, slug, type }: { leaseId: string; slug: string; type: string }) =>
      semaphore.resources.release({ leaseId, slug, type }),
    list: ({ type }: { type: string }) => semaphore.resources.list({ type }),
  };
}

const commonPreviewRuntime = {
  commandEnvironment: env,
  createPreviewSemaphoreResourceClient: createPreviewSemaphoreClient,
  repositoryRoot: process.cwd(),
};

export const router = os.router({
  preview: os.router({
    sync: os
      .input(createCloudflarePreviewSyncInputSchema(previewBoundaryEnv))
      .meta({
        description:
          "Deploy affected preview apps for the current pull request, run preview tests, and update the managed PR preview section",
        default: true,
      })
      .handler(async ({ input, signal }) => {
        const result = await syncCloudflarePreviewForPullRequest({
          ...input,
          ...commonPreviewRuntime,
          signal,
        });

        if (!result.ok) {
          throw new Error("Failed to sync Cloudflare preview apps.");
        }

        return result;
      }),
    deploy: os
      .input(createCloudflarePreviewSyncInputSchema(previewBoundaryEnv))
      .meta({
        description:
          "Deploy affected preview apps for the current pull request without running preview e2e",
      })
      .handler(async ({ input, signal }) => {
        const result = await deployCloudflarePreviewForPullRequest({
          ...input,
          ...commonPreviewRuntime,
          signal,
        });

        if (!result.ok) {
          throw new Error("Failed to deploy Cloudflare preview apps.");
        }

        return result;
      }),
    test: os
      .input(createCloudflarePreviewTestInputSchema(previewBoundaryEnv))
      .meta({
        description:
          "Run preview e2e against deployed apps recorded in the managed PR preview section",
      })
      .handler(async ({ input, signal }) => {
        const result = await testCloudflarePreviewForPullRequest({
          ...input,
          commandEnvironment: env,
          repositoryRoot: process.cwd(),
          signal,
        });

        if (!result.ok) {
          throw new Error("Failed to run Cloudflare preview tests.");
        }

        return result;
      }),
    cleanup: os
      .input(createCloudflarePreviewCleanupInputSchema(previewBoundaryEnv))
      .meta({
        description:
          "Tear down deployed apps recorded in the managed PR preview section and release the environment config lease",
      })
      .handler(async ({ input, signal }) => {
        const result = await cleanupCloudflarePreviewForPullRequest({
          ...input,
          ...commonPreviewRuntime,
          signal,
        });

        if (!result.ok) {
          throw new Error("Failed to clean up Cloudflare preview apps.");
        }

        return result;
      }),
    status: os
      .input(createPreviewStatusInputSchema(previewBoundaryEnv))
      .meta({
        description: "Show environment config lease inventory and active leases for PR previews",
      })
      .handler(async ({ input }) => {
        const semaphore = createPreviewSemaphoreClient(input);
        const now = Date.now();
        const resources = await semaphore.list({
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        });
        const available = resources
          .filter((resource) => resource.leaseState === "available")
          .map((resource) => ({
            data: resource.data,
            slug: resource.slug,
            lastReleasedAt:
              resource.lastReleasedAt === null
                ? null
                : new Date(resource.lastReleasedAt).toISOString(),
          }));
        const leased = resources
          .filter((resource) => resource.leaseState === "leased")
          .map((resource) => ({
            data: resource.data,
            slug: resource.slug,
            leasedUntil:
              resource.leasedUntil === null ? null : new Date(resource.leasedUntil).toISOString(),
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
          checkedAt: new Date(now).toISOString(),
          semaphoreBaseUrl: input.semaphoreBaseUrl,
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
          total: resources.length,
          availableCount: available.length,
          leasedCount: leased.length,
          nextLeaseExpiryAt: leased[0]?.leasedUntil ?? null,
          available,
          leased,
        };
      }),
    reconcile: os
      .input(createPreviewStatusInputSchema(previewBoundaryEnv))
      .meta({
        description:
          "Check live Semaphore environment config leases against Doppler configs and Cloudflare preview domain zones",
      })
      .handler(async ({ input, signal }) => {
        const semaphore = createPreviewSemaphoreClient(input);
        return await reconcileEnvironmentConfigLeaseResources({
          client: semaphore,
          commandEnvironment: env,
          repositoryRoot: process.cwd(),
          semaphoreBaseUrl: input.semaphoreBaseUrl,
          signal,
        });
      }),
  }),
});
