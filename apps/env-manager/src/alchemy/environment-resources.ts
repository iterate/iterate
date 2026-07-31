import { Database } from "alchemy/Cloudflare/D1";
import { Namespace } from "alchemy/Cloudflare/KV";
import { Bucket } from "alchemy/Cloudflare/R2";
import type { InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import type { CompiledEnvironment } from "../environments.ts";
import type { AlchemyResources } from "../state.ts";

/**
 * The complete Alchemy-owned graph for one deployed environment.
 */
export const makeEnvironmentResources = (environment: CompiledEnvironment) =>
  Effect.gen(function* () {
    const physicalStage = environment.stage.replaceAll("_", "-");
    const authDb = yield* Database("AuthDatabase", {
      name: `iterate-${physicalStage}-auth`,
    });

    if (environment.kind === "auth") {
      return {
        kind: "auth",
        stage: environment.stage,
        authDbId: authDb.databaseId,
      } satisfies InputProps<Extract<AlchemyResources, { kind: "auth" }>>;
    }

    const isPreview = environment.stage.startsWith("preview_");
    const projectDirectory = yield* Namespace("ProjectDirectory", {
      title: `iterate-${physicalStage}-project-directory`,
    });
    const workerBuildCache = yield* Namespace("WorkerBuildCache", {
      title: `iterate-${physicalStage}-worker-build-cache`,
    });
    const semaphoreDb = yield* Database("SemaphoreDatabase", {
      name: `iterate-${physicalStage}-semaphore`,
    });
    const files = yield* Bucket("Files", {
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
    const sandboxes = yield* Bucket("Sandboxes", {
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
      kind: "platform",
      stage: environment.stage,
      authDbId: authDb.databaseId,
      projectDirectoryKvId: projectDirectory.namespaceId,
      workerBuildCacheKvId: workerBuildCache.namespaceId,
      semaphoreDbId: semaphoreDb.databaseId,
      filesBucketName: files.bucketName,
      sandboxesBucketName: sandboxes.bucketName,
    } satisfies InputProps<Extract<AlchemyResources, { kind: "platform" }>>;
  });
