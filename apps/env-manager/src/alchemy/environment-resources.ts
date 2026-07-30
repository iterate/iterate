import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const makeAuthResources = (stage: string) =>
  Effect.gen(function* () {
    const physicalStage = stage.replaceAll("_", "-");
    const authDb = yield* Cloudflare.D1.Database("AuthDatabase", {
      name: `iterate-${physicalStage}-auth`,
    });
    return {
      kind: "auth" as const,
      authDbId: authDb.databaseId,
    };
  });

/**
 * The complete Alchemy-owned part of one platform environment.
 *
 * This graph has no runtime policy: no filesystem, credentials, state store,
 * CLI, or Durable Object. The normal local Alchemy entrypoint and the
 * Environment Durable Object compile this exact Effect with different layers.
 */
export const makeEnvironmentResources = (stage: string) =>
  Effect.gen(function* () {
    const physicalStage = stage.replaceAll("_", "-");
    const isPreview = stage.startsWith("preview_");
    const authDb = yield* Cloudflare.D1.Database("AuthDatabase", {
      name: `iterate-${physicalStage}-auth`,
    });
    const projectDirectory = yield* Cloudflare.KV.Namespace("ProjectDirectory", {
      title: `iterate-${physicalStage}-project-directory`,
    });
    const workerBuildCache = yield* Cloudflare.KV.Namespace("WorkerBuildCache", {
      title: `iterate-${physicalStage}-worker-build-cache`,
    });
    const semaphoreDb = yield* Cloudflare.D1.Database("SemaphoreDatabase", {
      name: `iterate-${physicalStage}-semaphore`,
    });
    const files = yield* Cloudflare.R2.Bucket("Files", {
      name: `iterate-${physicalStage}-files`,
      lifecycleRules: isPreview
        ? [
            {
              id: "expire-preview-files",
              deleteObjectsTransition: { condition: { type: "Age", maxAge: 3 * 60 * 60 } },
            },
          ]
        : [],
    });
    const sandboxes = yield* Cloudflare.R2.Bucket("Sandboxes", {
      name: `iterate-${physicalStage}-sandboxes`,
      lifecycleRules: [
        {
          id: "expire-sandbox-workspace-backups",
          prefix: "backups/",
          deleteObjectsTransition: {
            condition: { type: "Age", maxAge: isPreview ? 3 * 60 * 60 : 90 * 24 * 60 * 60 },
          },
        },
      ],
    });

    return {
      kind: "platform" as const,
      authDbId: authDb.databaseId,
      projectDirectoryKvId: projectDirectory.namespaceId,
      workerBuildCacheKvId: workerBuildCache.namespaceId,
      semaphoreDbId: semaphoreDb.databaseId,
      filesBucketName: files.bucketName,
      sandboxesBucketName: sandboxes.bucketName,
    };
  });
