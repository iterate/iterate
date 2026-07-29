import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { authEnvs, envs } from "../envs.ts";
import type { AlchemyResources } from "../scripts/lib/alchemy-resources.ts";

const WriteWranglerInputs = Alchemy.Action(
  "WriteWranglerInputs",
  (input: { resources: AlchemyResources; runId: string }) =>
    Effect.sync(() => {
      const path = fileURLToPath(
        new URL(`./output/${input.resources.stage}/cloudflare-resources.json`, import.meta.url),
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, `${JSON.stringify(input.resources, null, 2)}\n`);
      renameSync(`${path}.tmp`, path);
      return input.resources;
    }),
);

export default Alchemy.Stack(
  "IterateDataResources",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    // Alchemy's state-inspection commands evaluate the stack with this
    // internal stage solely to discover its configured state store:
    // https://github.com/alchemy-run/alchemy/blob/cd6671e297375282104ba81ec6dcb6347ab7a0fd/packages/alchemy/src/Cli/commands/_shared.ts#L374-L383
    if (stage === "placeholder") return;
    const auth = Object.values(authEnvs).find((candidate) => candidate.dopplerConfig === stage);
    if (!auth) {
      return yield* Effect.die(new Error(`Unknown deployed environment ${stage}.`));
    }
    // Actions are skipped when their input hash is unchanged. A fresh input
    // rematerializes this checkout-local, fail-closed manifest after every
    // successful deploy without forcing the Cloudflare resources themselves:
    // https://github.com/alchemy-run/alchemy/blob/cd6671e297375282104ba81ec6dcb6347ab7a0fd/packages/alchemy/src/Plan.ts#L1129-L1161
    const runId = randomUUID();

    const authDb = yield* Cloudflare.D1.Database("AuthDatabase", {
      name: `${auth.authWorkerName}-auth-db`,
    });
    const env = Object.values(envs).find((candidate) => candidate.dopplerConfig === stage);
    if (!env) {
      return yield* WriteWranglerInputs({
        resources: {
          kind: "auth",
          stage,
          accountId: auth.cloudflareAccountId,
          authDbId: authDb.databaseId,
        },
        runId,
      });
    }
    const isPreview = stage.startsWith("preview_");
    const projectDirectory = yield* Cloudflare.KV.Namespace("ProjectDirectory", {
      title: `${env.osWorkerName}-project-directory`,
    });
    const workerBuildCache = yield* Cloudflare.KV.Namespace("WorkerBuildCache", {
      title: `${env.osWorkerName}-worker-build-cache`,
    });
    const semaphoreDb = yield* Cloudflare.D1.Database("SemaphoreDatabase", {
      name: `${env.semaphoreWorkerName}-resources`,
    });
    yield* Cloudflare.R2.Bucket("Files", {
      name: `${env.osWorkerName}-files`,
      lifecycleRules: isPreview
        ? [
            {
              id: "expire-preview-files",
              deleteObjectsTransition: { condition: { type: "Age", maxAge: 3 * 60 * 60 } },
            },
          ]
        : [],
    });
    yield* Cloudflare.R2.Bucket("Sandboxes", {
      name: `${env.osWorkerName}-sandboxes`,
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

    return yield* WriteWranglerInputs({
      resources: {
        kind: "platform",
        stage,
        accountId: env.cloudflareAccountId,
        authDbId: authDb.databaseId,
        projectDirectoryKvId: projectDirectory.namespaceId,
        workerBuildCacheKvId: workerBuildCache.namespaceId,
        semaphoreDbId: semaphoreDb.databaseId,
      },
      runId,
    });
  }),
);
