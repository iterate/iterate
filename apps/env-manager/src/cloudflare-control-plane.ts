import { API, NotFound, T, type DefaultErrors } from "@distilled.cloud/cloudflare";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as D1 from "@distilled.cloud/cloudflare/d1";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as KV from "@distilled.cloud/cloudflare/kv";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { AlchemyResources, ResourceProgress } from "./state.ts";

const ARTIFACT_DELETE_CONCURRENCY = 10;
const ARTIFACT_DELETE_BATCH_SIZE = 1_000;
const ARTIFACT_REPOSITORY_PAGE_SIZE = 200;
const DELETED_WORKER_COMPATIBILITY_DATE = "2026-07-30";
const DELETED_WORKER_MODULE = new File(
  [
    "export default { async fetch() { return new Response('Environment deleted', { status: 410 }); } };",
  ],
  "worker.js",
  { type: "application/javascript+module" },
);

// The Artifacts control-plane endpoints are not in Cloudflare's OpenAPI
// document yet, so Distilled cannot generate these two operations. Defining
// them through Distilled's API builder still gives them the same credentials,
// transport, response decoding, typed errors, and bounded retry machinery.
const ListArtifactRepositoriesRequest = Schema.Struct({
  accountId: Schema.String.pipe(T.HttpPath("account_id")),
  namespace: Schema.String.pipe(T.HttpPath("namespace")),
  limit: Schema.optional(Schema.Number).pipe(T.HttpQuery("limit")),
  cursor: Schema.optional(Schema.String).pipe(T.HttpQuery("cursor")),
}).pipe(
  T.Http({
    method: "GET",
    path: "/accounts/{account_id}/artifacts/namespaces/{namespace}/repos",
  }),
);
const ArtifactRepository = Schema.Struct({ name: Schema.String });
const ListArtifactRepositoriesResponse = Schema.Struct({
  result: Schema.Array(ArtifactRepository),
  resultInfo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cursor: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
}).pipe(
  Schema.encodeKeys({
    result: "result",
    resultInfo: "result_info",
  }),
);
const listArtifactRepositories: API.PaginatedOperationMethod<
  Readonly<{ accountId: string; namespace: string; limit?: number; cursor?: string }>,
  Readonly<{
    result: ReadonlyArray<Readonly<{ name: string }>>;
    resultInfo?: Readonly<{ cursor?: string | null }> | null;
  }>,
  NotFound,
  Credentials.Credentials
> = API.makePaginated(() => ({
  input: ListArtifactRepositoriesRequest,
  output: ListArtifactRepositoriesResponse,
  errors: [NotFound],
  pagination: {
    mode: "cursor",
    inputToken: "cursor",
    outputToken: "resultInfo.cursor",
    items: "result",
    pageSize: "limit",
  },
}));

const DeleteArtifactRepositoryRequest = Schema.Struct({
  accountId: Schema.String.pipe(T.HttpPath("account_id")),
  namespace: Schema.String.pipe(T.HttpPath("namespace")),
  repository: Schema.String.pipe(T.HttpPath("repository")),
}).pipe(
  T.Http({
    method: "DELETE",
    path: "/accounts/{account_id}/artifacts/namespaces/{namespace}/repos/{repository}",
  }),
);
const DeleteArtifactRepositoryResponse = Schema.Unknown.pipe(T.ResponsePath("result"));
const deleteArtifactRepository: API.OperationMethod<
  Readonly<{ accountId: string; namespace: string; repository: string }>,
  unknown,
  NotFound,
  Credentials.Credentials
> = API.make(() => ({
  input: DeleteArtifactRepositoryRequest,
  output: DeleteArtifactRepositoryResponse,
  errors: [NotFound],
}));

const WorkerUploadFile = Schema.declare(
  (input): input is File => typeof File !== "undefined" && input instanceof File,
  { identifier: "File", description: "A Worker module upload" },
);
const DeleteDurableObjectClassesRequest = Schema.Struct({
  accountId: Schema.String.pipe(T.HttpPath("account_id")),
  scriptName: Schema.String.pipe(T.HttpPath("scriptName")),
  metadata: Schema.Unknown,
  files: Schema.Array(WorkerUploadFile.pipe(T.HttpFormDataFile())),
}).pipe(
  T.Http({
    method: "PUT",
    path: "/accounts/{account_id}/workers/scripts/{scriptName}",
    contentType: "multipart",
  }),
);
const DeleteDurableObjectClassesResponse = Schema.Unknown.pipe(T.ResponsePath("result"));
const deleteDurableObjectClasses: API.OperationMethod<
  Readonly<{
    accountId: string;
    scriptName: string;
    metadata: unknown;
    files: readonly File[];
  }>,
  unknown,
  DefaultErrors,
  Credentials.Credentials
> = API.make(() => ({
  input: DeleteDurableObjectClassesRequest,
  output: DeleteDurableObjectClassesResponse,
  errors: [],
}));

export function makeCloudflareControlPlane(input: {
  accountId: string;
  apiToken: string;
  onProgress?: (progress: ResourceProgress) => void;
  signal?: AbortSignal;
}) {
  const cloudflareApi = Layer.mergeAll(
    Credentials.fromApiToken({ apiToken: input.apiToken }),
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch),
  );
  const run = <A, E>(
    program: Effect.Effect<A, E, Credentials.Credentials | HttpClient.HttpClient>,
  ) =>
    Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(cloudflareApi))), {
      signal: input.signal,
    });

  const listWorkerScripts = () =>
    Workers.listScripts.items({ accountId: input.accountId }).pipe(Stream.runCollect);

  const listDurableObjectNamespaces = () =>
    DurableObjects.listNamespaces
      .items({ accountId: input.accountId, perPage: 100 })
      .pipe(Stream.runCollect);

  const listArtifactRepositoriesInNamespace = (namespace: string, limit: number) =>
    listArtifactRepositories
      .items({
        accountId: input.accountId,
        namespace,
        limit: ARTIFACT_REPOSITORY_PAGE_SIZE,
      })
      .pipe(
        Stream.take(limit),
        Stream.runCollect,
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );

  const destroyArtifactRepositories = (namespace: string) =>
    Effect.gen(function* () {
      const repositories = yield* listArtifactRepositoriesInNamespace(
        namespace,
        ARTIFACT_DELETE_BATCH_SIZE,
      );
      let deleted = 0;
      input.onProgress?.({
        id: "wrangler-artifacts",
        type: "Cloudflare Artifacts",
        status: "deleting",
        message: `Deleting a bounded batch of ${repositories.length} repositories from ${namespace}.`,
      });
      yield* Effect.forEach(
        repositories,
        ({ name }) =>
          deleteArtifactRepository({
            accountId: input.accountId,
            namespace,
            repository: name,
          }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.tap(() =>
              Effect.sync(() => {
                deleted += 1;
                if (deleted % 100 === 0 || deleted === repositories.length) {
                  input.onProgress?.({
                    id: "wrangler-artifacts",
                    type: "Cloudflare Artifacts",
                    status: "deleting",
                    message: `Deleted ${deleted}/${repositories.length} repositories from ${namespace}.`,
                  });
                }
              }),
            ),
          ),
        { concurrency: ARTIFACT_DELETE_CONCURRENCY },
      );

      const remaining = yield* listArtifactRepositoriesInNamespace(namespace, 1);
      if (remaining.length > 0) {
        input.onProgress?.({
          id: "wrangler-artifacts",
          type: "Cloudflare Artifacts",
          status: "destroying",
          message: `Deleted a bounded batch of ${repositories.length} repositories from ${namespace}; canonical Cloudflare inventory still contains repositories.`,
        });
        return false;
      }
      input.onProgress?.({
        id: "wrangler-artifacts",
        type: "Cloudflare Artifacts",
        status: "deleted",
        message: `Deleted every repository from ${namespace}.`,
      });
      return true;
    });

  const destroyContainerApplications = (workerName: string) =>
    Effect.gen(function* () {
      const namespaceIds = new Set(
        (yield* listDurableObjectNamespaces()).flatMap(({ id, script }) =>
          id && script === workerName ? [id] : [],
        ),
      );
      const applications = yield* Containers.listContainerApplications({
        accountId: input.accountId,
      });
      const owned = applications.filter(({ durableObjects }) => {
        const namespaceId = durableObjects?.namespaceId;
        return namespaceId !== undefined && namespaceIds.has(namespaceId);
      });
      for (const application of owned) {
        yield* Containers.deleteContainerApplication({
          accountId: input.accountId,
          applicationId: application.id,
        }).pipe(Effect.catchTag("ContainerApplicationNotFound", () => Effect.void));
      }

      const remaining = (yield* Containers.listContainerApplications({
        accountId: input.accountId,
      })).filter(({ durableObjects }) => {
        const namespaceId = durableObjects?.namespaceId;
        return namespaceId !== undefined && namespaceIds.has(namespaceId);
      });
      if (remaining.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Container applications remain for ${workerName}: ${remaining
              .map(({ name }) => name)
              .join(", ")}`,
          ),
        );
      }
    });

  const destroyWorker = (
    workerName: string,
    namespaceClasses: ReadonlyMap<string, ReadonlySet<string>>,
    workerExists: boolean,
  ) =>
    Effect.gen(function* () {
      const classes = new Set(namespaceClasses.get(workerName));
      const settings = workerExists
        ? yield* Workers.getScriptScriptAndVersionSetting({
            accountId: input.accountId,
            scriptName: workerName,
          }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)))
        : undefined;
      for (const binding of settings?.bindings ?? []) {
        if (
          binding.type === "durable_object_namespace" &&
          typeof binding.className === "string" &&
          (!binding.scriptName || binding.scriptName === workerName)
        ) {
          classes.add(binding.className);
        }
      }

      // `force=true` removes bindings but not owned Durable Object classes.
      // These Workers already use declarative exports, where legacy migrations
      // are forbidden. Replace every owned class with a deleted tombstone first;
      // replacing the module also stops application alarms during teardown. If
      // the script disappeared during a partial teardown, this creates the
      // minimal dummy Worker needed to retire its still-owned namespaces.
      if (classes.size > 0) {
        yield* deleteDurableObjectClasses({
          accountId: input.accountId,
          scriptName: workerName,
          metadata: {
            main_module: DELETED_WORKER_MODULE.name,
            compatibility_date: settings?.compatibilityDate ?? DELETED_WORKER_COMPATIBILITY_DATE,
            compatibility_flags: settings?.compatibilityFlags ?? undefined,
            bindings: [],
            exports: Object.fromEntries(
              [...classes].map((className) => [
                className,
                { type: "durable-object", state: "deleted" },
              ]),
            ),
          },
          files: [DELETED_WORKER_MODULE],
        });
      }

      yield* Workers.deleteScript({
        accountId: input.accountId,
        scriptName: workerName,
        force: true,
      }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
    });

  return {
    assertAlchemyResourcesExist(resources: AlchemyResources) {
      return run(
        Effect.gen(function* () {
          const [databases, namespaces, { buckets }] = yield* Effect.all(
            [
              D1.listDatabases.items({ accountId: input.accountId }).pipe(Stream.runCollect),
              KV.listNamespaces.items({ accountId: input.accountId }).pipe(Stream.runCollect),
              R2.listBuckets({ accountId: input.accountId, perPage: 1_000 }),
            ],
            { concurrency: "unbounded" },
          );
          const databaseIds = new Set(databases.map(({ uuid }) => uuid));
          const namespaceIds = new Set(namespaces.map(({ id }) => id));
          const bucketNames = new Set((buckets ?? []).map(({ name }) => name));
          const expected: Array<readonly [label: string, present: boolean]> = [
            ["auth D1", databaseIds.has(resources.authDbId)],
          ];
          if (resources.kind === "platform") {
            expected.push(
              ["project-directory KV", namespaceIds.has(resources.projectDirectoryKvId)],
              ["worker-build-cache KV", namespaceIds.has(resources.workerBuildCacheKvId)],
              ["semaphore D1", databaseIds.has(resources.semaphoreDbId)],
              ["files R2", bucketNames.has(resources.filesBucketName)],
              ["sandboxes R2", bucketNames.has(resources.sandboxesBucketName)],
            );
          }
          const missing = expected.filter(([, present]) => !present).map(([label]) => label);
          if (missing.length > 0) {
            return yield* Effect.fail(
              new Error(`Cloudflare resources are missing: ${missing.join(", ")}`),
            );
          }
        }),
      );
    },

    destroyWranglerResources(destroyInput: {
      workerNames: readonly string[];
      osWorkerName?: string;
    }) {
      return run(
        Effect.gen(function* () {
          if (destroyInput.osWorkerName !== undefined) {
            input.onProgress?.({
              id: "wrangler-containers",
              type: "Wrangler containers",
              status: "deleting",
            });
            yield* destroyContainerApplications(destroyInput.osWorkerName);
            input.onProgress?.({
              id: "wrangler-containers",
              type: "Wrangler containers",
              status: "deleted",
            });
          }

          const [namespaces, workers] = yield* Effect.all(
            [listDurableObjectNamespaces(), listWorkerScripts()],
            { concurrency: "unbounded" },
          );
          const namespaceClasses = new Map<string, Set<string>>();
          for (const namespace of namespaces) {
            if (namespace.script && namespace.class) {
              const classes = namespaceClasses.get(namespace.script) ?? new Set<string>();
              classes.add(namespace.class);
              namespaceClasses.set(namespace.script, classes);
            }
          }
          const workerNames = new Set(workers.flatMap(({ id }) => (id ? [id] : [])));
          let deletedWorkers = 0;

          // Keep Worker teardown sequential because this endpoint is
          // rate-limited per API user.
          for (const [index, workerName] of destroyInput.workerNames.entries()) {
            if (!workerNames.has(workerName) && !namespaceClasses.has(workerName)) continue;
            input.onProgress?.({
              id: "wrangler-workers",
              type: "Wrangler Workers",
              status: "deleting",
              message: `Deleting ${index + 1}/${destroyInput.workerNames.length}: ${workerName}.`,
            });
            yield* destroyWorker(workerName, namespaceClasses, workerNames.has(workerName));
            deletedWorkers += 1;
          }

          const targets = new Set(destroyInput.workerNames);
          const [remainingWorkers, remainingNamespaces] = yield* Effect.all(
            [
              listWorkerScripts().pipe(
                Effect.map((workers) =>
                  workers.filter(({ id }) => typeof id === "string" && targets.has(id)),
                ),
              ),
              listDurableObjectNamespaces().pipe(
                Effect.map((namespaces) =>
                  namespaces.filter(
                    ({ script }) => typeof script === "string" && targets.has(script),
                  ),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );
          if (remainingWorkers.length > 0 || remainingNamespaces.length > 0) {
            return yield* Effect.fail(
              new Error(
                [
                  remainingWorkers.length > 0
                    ? `Workers remain: ${remainingWorkers.map(({ id }) => id).join(", ")}`
                    : undefined,
                  remainingNamespaces.length > 0
                    ? `Durable Object namespaces remain for: ${[
                        ...new Set(remainingNamespaces.map(({ script }) => script)),
                      ].join(", ")}`
                    : undefined,
                ]
                  .filter((message) => message !== undefined)
                  .join("; "),
              ),
            );
          }
          input.onProgress?.({
            id: "wrangler-workers",
            type: "Wrangler Workers",
            status: "deleted",
            message: `Deleted ${deletedWorkers} Workers; verified all ${destroyInput.workerNames.length} Workers and their Durable Object namespaces absent.`,
          });

          return destroyInput.osWorkerName === undefined
            ? true
            : yield* destroyArtifactRepositories(`${destroyInput.osWorkerName}-repos`);
        }),
      );
    },
  };
}
