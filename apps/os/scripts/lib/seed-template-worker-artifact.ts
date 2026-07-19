/**
 * Deploy-time template artifact seeding — the TRUSTED build-key tier's only
 * writer (see build-key.ts).
 *
 * Every fresh project seeds its config repo from one deterministic template.
 * The deploy host prebuilds every template recipe under content-only trusted
 * keys: the root worker needed during project birth plus each seeded app's
 * independent page and stateful-API builds. Fresh projects therefore never
 * cold-build repo-owned template code inside a request; the project-scoped
 * container lane remains for real config edits.
 *
 * Everything here is shared with the runtime resolver — the seed file map
 * (projectRepoSeedFiles), the content hash (repoContentHash), the sdk virtual
 * module injection, the build key, the recipe, and the KV artifact layout
 * (KvWorkerBuildArtifactStore over a REST adapter) — because any private
 * reimplementation would eventually fork and the miss is SILENT (birth just
 * quietly starts building in containers again).
 */
import {
  guestbookAppRef,
  guestbookPageSource,
} from "../../config-repo-template/apps/guestbook/src/guestbook-ref.ts";
import {
  tanstackPageSource,
  tanstackTodosRef,
} from "../../config-repo-template/apps/tanstack/src/todos-ref.ts";
import { repoContentHash } from "../../src/domains/repos/checkout-files.ts";
import { projectRepoSeedFiles } from "../../src/domains/repos/project-repo-seed.ts";
import { defaultProjectWorkerRef } from "../../src/domains/repos/utils.ts";
import {
  KvWorkerBuildArtifactStore,
  type WorkerBuildArtifact,
} from "../../src/domains/workers/artifact-store.ts";
import {
  workerBuildKey,
  type ResolvedWorkerFileSource,
} from "../../src/domains/workers/build-key.ts";
import {
  WORKER_COMPATIBILITY_DATE,
  WORKER_COMPATIBILITY_FLAGS,
  canonicalWorkerBuildOptions,
  workerBuildRecipe,
} from "../../src/domains/workers/build-recipe.ts";
import type { WorkerBuildOptions } from "../../src/domains/workers/schemas.ts";
import { runWorkerBuildRecipeOnHost } from "./worker-build-host-runner.ts";

export async function seedTemplateWorkerArtifacts(input: {
  accountId: string;
  apiToken: string;
  kvNamespaceId: string;
  /** The env's `iterate` package spec override (preview deploys pass their
   * PR's pkg.pr.new build) — must be the SAME value the deployed worker's
   * config carries, or the seeded content hash matches no real project. */
  iterateSdkPackageSpec: string | undefined;
  log?: (message: string) => void;
}): Promise<Array<{ buildKey: string; seeded: boolean }>> {
  const log = input.log ?? console.log;
  const files = Object.fromEntries(
    projectRepoSeedFiles(input.iterateSdkPackageSpec).map((file) => [file.path, file.content]),
  );

  // The exact identity the runtime resolver computes for a fresh project's
  // default worker: the seed's whole-tree content hash (what the repo seed
  // records in its head cache) plus the canonical ref's masks and options
  // (sdk virtual module injected, same as resolveThroughBuilder).
  const ref = defaultProjectWorkerRef();
  if (ref.source.files.type !== "repo") throw new Error("default worker ref must be repo-backed");
  const source: ResolvedWorkerFileSource = {
    // Content identity replaces the commit in the key (build-key.ts), so
    // the placeholder oid never participates.
    commitOid: "0".repeat(40),
    contentHash: await repoContentHash(files),
    exclude: ref.source.files.exclude,
    repoPath: ref.source.files.repoPath,
    type: "repo",
  };
  const builds: Array<{ label: string; options: WorkerBuildOptions }> = [
    { label: "project worker", options: ref.source.options ?? {} },
    {
      label: "TanStack pages",
      options: tanstackPageSource.options,
    },
    {
      label: "TanStack todo API",
      options: tanstackTodosRef.source.options,
    },
    {
      label: "guestbook pages",
      options: guestbookPageSource.options,
    },
    {
      label: "guestbook API",
      options: guestbookAppRef.source.options,
    },
  ];

  const store = new KvWorkerBuildArtifactStore(
    restKvNamespace(input) as unknown as KVNamespace,
    // Every deploy REWRITES the artifact (KV TTLs are fixed at write time —
    // a read never extends them), so the seed can be shorter-lived than
    // runtime artifacts; generous enough that a quiet env (no deploys for
    // days) keeps its fast creates.
    { expirationTtlSeconds: 14 * 24 * 60 * 60 },
  );
  // These five recipes are independent, each runner owns a separate temporary
  // directory, and preview CI deliberately has eight cores. A preview head
  // pins a new pkg.pr.new URL, so even an OS-only change correctly gives the
  // template a new content hash and usually misses every trusted key. Running
  // those misses serially added the sum of four installs/builds (~55s in
  // preview CI) to every OS deploy; bounded fan-out makes the deploy pay the
  // slowest recipe instead. npm/nub's shared download caches are concurrency-
  // safe, and Promise.all preserves the build declaration order in the
  // returned evidence even though log lines may interleave.
  return await Promise.all(
    builds.map(async (build): Promise<{ buildKey: string; seeded: boolean }> => {
      const options = canonicalWorkerBuildOptions(build.options);
      const buildKey = await workerBuildKey({
        compatibilityDate: WORKER_COMPATIBILITY_DATE,
        compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
        options,
        source,
      });
      const existing = await store.get(buildKey);
      if (existing !== null) {
        // Same bytes, fresh write-time TTL — skips the build without letting a
        // stable key's artifact quietly expire between deploys.
        await store.put(existing);
        log(
          `${build.label} template artifact already seeded (${buildKey.slice(0, 12)}…) — TTL refreshed`,
        );
        return { buildKey, seeded: false };
      }

      log(`building ${build.label} template artifact ${buildKey.slice(0, 12)}…`);
      const result = await runWorkerBuildRecipeOnHost(workerBuildRecipe({ files, options }));
      if (result.status === "build-failed") {
        throw new Error(`${build.label} template build failed:\n${result.message}`);
      }
      const artifact: WorkerBuildArtifact = {
        buildKey,
        mainModule: result.mainModule,
        modules: result.modules,
      };
      await store.put(artifact);
      log(
        `seeded ${build.label} template artifact ${buildKey.slice(0, 12)}… ` +
          `(${Object.keys(result.modules).length} modules)`,
      );
      return { buildKey, seeded: true };
    }),
  );
}

/**
 * The exact KVNamespace subset KvWorkerBuildArtifactStore uses, over the
 * Cloudflare REST API. Hand-rolled fetch (not ctx.cf): the KV values endpoint
 * answers RAW bytes on GET, not the v4 JSON envelope ctx.cf assumes.
 */
function restKvNamespace(input: { accountId: string; apiToken: string; kvNamespaceId: string }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/storage/kv/namespaces/${input.kvNamespaceId}/values/`;
  const headers = { authorization: `Bearer ${input.apiToken}` };
  return {
    async get(key: string, type?: string): Promise<unknown> {
      const response = await fetch(base + encodeURIComponent(key), { headers });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`KV read ${key} failed: ${response.status}`);
      const text = await response.text();
      return type === "json" ? JSON.parse(text) : text;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const url = new URL(base + encodeURIComponent(key));
      if (options?.expirationTtl !== undefined) {
        url.searchParams.set("expiration_ttl", String(options.expirationTtl));
      }
      const response = await fetch(url, { body: value, headers, method: "PUT" });
      if (!response.ok) {
        throw new Error(`KV write ${key} failed: ${response.status} ${await response.text()}`);
      }
    },
    async delete(key: string): Promise<void> {
      const response = await fetch(base + encodeURIComponent(key), { headers, method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`KV delete ${key} failed: ${response.status}`);
      }
    },
  };
}
