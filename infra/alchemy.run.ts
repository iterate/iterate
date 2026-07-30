import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import { authEnvs, envs } from "../envs.ts";
import type { AlchemyResources } from "../scripts/lib/alchemy-resources.ts";

const WriteWranglerInputs = Alchemy.Action(
  "WriteWranglerInputs",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stage = yield* Alchemy.Stage;
    const outputRoot = yield* path.fromFileUrl(new URL("./output", import.meta.url));

    return Effect.fn(function* (input: { resources: AlchemyResources; nonce: number }) {
      const outputDirectory = path.join(outputRoot, stage);
      const outputPath = path.join(outputDirectory, "cloudflare-resources.json");
      yield* fileSystem.makeDirectory(outputDirectory, { recursive: true });
      const temporaryPath = yield* fileSystem.makeTempFileScoped({
        directory: outputDirectory,
        prefix: "cloudflare-resources-",
        suffix: ".json",
      });
      yield* fileSystem.writeFileString(
        temporaryPath,
        `${JSON.stringify(input.resources, null, 2)}\n`,
      );
      yield* fileSystem.rename(temporaryPath, outputPath);
    }, Effect.scoped);
  }),
);

export default Alchemy.Stack(
  "IterateDataResources",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    // Alchemy's state-inspection commands evaluate the stack with this
    // internal stage solely to discover its configured state store:
    // https://github.com/alchemy-run/alchemy/blob/cd6671e297375282104ba81ec6dcb6347ab7a0fd/packages/alchemy/src/Cli/commands/state.ts#L73-L99
    if (stage === "placeholder") return;
    if (!Object.values(authEnvs).some((candidate) => candidate.dopplerConfig === stage)) {
      return yield* Effect.die(new Error(`Unknown deployed environment ${stage}.`));
    }
    // Actions are skipped when their input hash is unchanged. A fresh input
    // rematerializes this checkout-local, fail-closed manifest after every
    // successful deploy without forcing the Cloudflare resources themselves:
    // https://github.com/alchemy-run/alchemy/blob/cd6671e297375282104ba81ec6dcb6347ab7a0fd/packages/alchemy/src/Plan.ts#L1129-L1161
    const nonce = yield* Random.nextInt;

    const authDb = yield* Cloudflare.D1.Database("AuthDatabase");
    if (!Object.values(envs).some((candidate) => candidate.dopplerConfig === stage)) {
      yield* WriteWranglerInputs({
        resources: {
          kind: "auth",
          authDbId: authDb.databaseId,
        },
        nonce,
      });
      return;
    }
    const isPreview = stage.startsWith("preview_");
    const projectDirectory = yield* Cloudflare.KV.Namespace("ProjectDirectory");
    const workerBuildCache = yield* Cloudflare.KV.Namespace("WorkerBuildCache");
    const semaphoreDb = yield* Cloudflare.D1.Database("SemaphoreDatabase");
    const files = yield* Cloudflare.R2.Bucket("Files", {
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

    yield* WriteWranglerInputs({
      resources: {
        kind: "platform",
        authDbId: authDb.databaseId,
        projectDirectoryKvId: projectDirectory.namespaceId,
        workerBuildCacheKvId: workerBuildCache.namespaceId,
        semaphoreDbId: semaphoreDb.databaseId,
        filesBucketName: files.bucketName,
        sandboxesBucketName: sandboxes.bucketName,
      },
      nonce,
    });
  }),
);
