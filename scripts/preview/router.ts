import { resolve } from "node:path";
import { os } from "@orpc/server";
import { z } from "zod";
import { createSemaphoreClient } from "../../apps/semaphore-contract/src/client.ts";
import { CloudflarePreviewAppSlug, cloudflarePreviewApps } from "./apps.ts";
import {
  cleanupCloudflarePreviewForPullRequest,
  createCloudflarePreviewCleanupInputSchema,
  createCloudflarePreviewSyncInputSchema,
  createCloudflarePreviewTestInputSchema,
  deployCloudflarePreviewForPullRequest,
  syncCloudflarePreviewForPullRequest,
  testCloudflarePreviewForPullRequest,
} from "./preview.ts";

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
    release: ({ leaseId, slug, type }: { leaseId: string; slug: string; type: string }) =>
      semaphore.resources.release({ leaseId, slug, type }),
    list: ({ type }: { type: string }) => semaphore.resources.list({ type }),
  };
}

function getPreviewAppRuntime(app: (typeof cloudflarePreviewApps)[CloudflarePreviewAppSlug]) {
  return {
    appDisplayName: app.displayName,
    appSlug: app.slug,
    commandEnvironment: env,
    createPreviewSemaphoreResourceClient: createPreviewSemaphoreClient,
    dopplerProject: app.dopplerProject,
    previewResourceType: app.previewResourceType,
    previewTestBaseUrlEnvVar: app.previewTestBaseUrlEnvVar,
    previewTestCommandArgs: app.previewTestCommandArgs,
    workingDirectory: resolve(process.cwd(), app.appPath),
  };
}

async function runPreviewLifecycleForAllApps<Result>(params: {
  handler: (app: (typeof cloudflarePreviewApps)[CloudflarePreviewAppSlug]) => Promise<Result>;
  onFailure: (input: { appSlug: string; result: Result }) => boolean;
  verb: string;
}) {
  const results: Array<
    | { appSlug: string; status: "ok"; result: Result }
    | { appSlug: string; errorMessage: string; status: "error" }
  > = [];

  for (const app of Object.values(cloudflarePreviewApps)) {
    try {
      results.push({
        appSlug: app.slug,
        result: await params.handler(app),
        status: "ok",
      });
    } catch (error) {
      results.push({
        appSlug: app.slug,
        errorMessage: getErrorMessage(error),
        status: "error",
      });
    }
  }

  const failed = results.filter(
    (result) =>
      result.status === "error" ||
      (result.status === "ok" &&
        params.onFailure({
          appSlug: result.appSlug,
          result: result.result,
        })),
  );
  if (failed.length > 0) {
    throw new Error(
      `Failed to ${params.verb} previews for: ${failed.map(({ appSlug }) => appSlug).join(", ")}`,
    );
  }

  return { results };
}

export const router = os.router({
  preview: os.router({
    sync: os
      .input(
        createCloudflarePreviewSyncInputSchema(previewBoundaryEnv).extend({
          app: CloudflarePreviewAppSlug,
        }),
      )
      .meta({
        description:
          "Recreate an app preview for the current pull request and update the managed PR preview section",
        default: true,
      })
      .handler(async ({ input, signal }) => {
        const app = cloudflarePreviewApps[input.app];
        const result = await syncCloudflarePreviewForPullRequest({
          ...input,
          paths: app.paths,
          signal,
          ...getPreviewAppRuntime(app),
        });

        if (!result.ok) {
          throw new Error(result.entry.message ?? `Failed to sync ${app.displayName} preview.`);
        }

        return result;
      }),
    deploy: os
      .input(
        createCloudflarePreviewSyncInputSchema(previewBoundaryEnv).extend({
          app: CloudflarePreviewAppSlug,
        }),
      )
      .meta({
        description:
          "Create or refresh an app preview for the current pull request without running preview e2e",
      })
      .handler(async ({ input, signal }) => {
        const app = cloudflarePreviewApps[input.app];
        const result = await deployCloudflarePreviewForPullRequest({
          ...input,
          paths: app.paths,
          signal,
          ...getPreviewAppRuntime(app),
        });

        if (!result.ok) {
          throw new Error(result.entry?.message ?? `Failed to deploy ${app.displayName} preview.`);
        }

        return result;
      }),
    test: os
      .input(
        createCloudflarePreviewTestInputSchema(previewBoundaryEnv).extend({
          app: CloudflarePreviewAppSlug,
        }),
      )
      .meta({
        description:
          "Run preview e2e against an existing app preview recorded in the managed PR preview section",
      })
      .handler(async ({ input, signal }) => {
        const app = cloudflarePreviewApps[input.app];
        const result = await testCloudflarePreviewForPullRequest({
          ...input,
          signal,
          ...getPreviewAppRuntime(app),
        });

        if (!result.ok) {
          throw new Error(
            result.entry?.message ?? `Failed to run ${app.displayName} preview tests.`,
          );
        }

        return result;
      }),
    syncAll: os
      .input(createCloudflarePreviewSyncInputSchema(previewBoundaryEnv))
      .meta({
        description:
          "Recreate previews for all preview-managed apps on the current pull request and update the managed PR preview section",
      })
      .handler(async ({ input, signal }) =>
        runPreviewLifecycleForAllApps({
          handler: async (app) =>
            syncCloudflarePreviewForPullRequest({
              ...input,
              paths: app.paths,
              signal,
              ...getPreviewAppRuntime(app),
            }),
          onFailure: ({ result }) => !result.ok,
          verb: "sync",
        }),
      ),
    cleanup: os
      .input(
        createCloudflarePreviewCleanupInputSchema(previewBoundaryEnv).extend({
          app: CloudflarePreviewAppSlug,
        }),
      )
      .meta({
        description: "Clean up an app preview recorded in the managed PR preview section",
      })
      .handler(async ({ input, signal }) => {
        const app = cloudflarePreviewApps[input.app];
        const result = await cleanupCloudflarePreviewForPullRequest({
          ...input,
          signal,
          ...getPreviewAppRuntime(app),
        });

        if (!result.ok) {
          throw new Error(
            result.entry?.message ?? `Failed to clean up ${app.displayName} preview.`,
          );
        }

        return result;
      }),
    cleanupAll: os
      .input(createCloudflarePreviewCleanupInputSchema(previewBoundaryEnv))
      .meta({
        description:
          "Clean up previews for all preview-managed apps recorded in the managed PR preview section",
      })
      .handler(async ({ input, signal }) =>
        runPreviewLifecycleForAllApps({
          handler: async (app) =>
            cleanupCloudflarePreviewForPullRequest({
              ...input,
              signal,
              ...getPreviewAppRuntime(app),
            }),
          onFailure: ({ result }) => !result.ok,
          verb: "clean up",
        }),
      ),
    status: os
      .input(createPreviewStatusInputSchema(previewBoundaryEnv))
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
