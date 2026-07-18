/**
 * Deploy-time template artifact seeding — the TRUSTED build-key tier's only
 * writer (see build-key.ts).
 *
 * Every fresh project seeds its config repo from one deterministic template,
 * and project birth immediately delivers events to the default project worker
 * — which blocks on that worker's build. Building at runtime would put a
 * container cold-boot on the critical path of every `projects.create` (the
 * saga's repo-ready wait is 60s) and birth one builder container PER PROJECT
 * (fixture-heavy flows like e2e collide with per-class instance caps) — both
 * observed live on preview before this step existed. So the deploy host —
 * real node, the same pinned wrangler as everywhere else — prebuilds the
 * template's artifact and writes it under the content-only trusted key;
 * fresh projects then never build at runtime at all, and the container lane
 * only runs for real config commits.
 *
 * Everything here is shared with the runtime resolver — the seed file map
 * (projectRepoSeedFiles), the content hash (repoContentHash), the sdk virtual
 * module injection, the build key, the recipe, and the KV artifact layout
 * (KvWorkerBuildArtifactStore over a REST adapter) — because any private
 * reimplementation would eventually fork and the miss is SILENT (birth just
 * quietly starts building in containers again).
 */
import { repoContentHash } from "../../src/domains/repos/checkout-files.ts";
import { projectRepoSeedFiles } from "../../src/domains/repos/project-repo-seed.ts";
import { defaultProjectWorkerRef } from "../../src/domains/repos/utils.ts";
import {
  KvWorkerBuildArtifactStore,
  type WorkerBuildArtifact,
} from "../../src/domains/workers/artifact-store.ts";
import { workerBuildKey } from "../../src/domains/workers/build-key.ts";
import {
  WORKER_COMPATIBILITY_DATE,
  WORKER_COMPATIBILITY_FLAGS,
  canonicalWorkerBuildOptions,
  workerBuildRecipe,
} from "../../src/domains/workers/build-recipe.ts";
import { runWorkerBuildRecipeOnHost } from "./worker-build-host-runner.ts";

export async function seedTemplateWorkerArtifact(input: {
  accountId: string;
  apiToken: string;
  kvNamespaceId: string;
  /** The env's `iterate` package spec override (preview deploys pass their
   * PR's pkg.pr.new build) — must be the SAME value the deployed worker's
   * config carries, or the seeded content hash matches no real project. */
  iterateSdkPackageSpec: string | undefined;
  log?: (message: string) => void;
}): Promise<{ buildKey: string; seeded: boolean }> {
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
  const options = canonicalWorkerBuildOptions(ref.source.options ?? {});
  const buildKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    options,
    source: {
      // Content identity replaces the commit in the key (build-key.ts), so
      // the placeholder oid never participates.
      commitOid: "0".repeat(40),
      contentHash: await repoContentHash(files),
      exclude: ref.source.files.exclude,
      repoPath: ref.source.files.repoPath,
      type: "repo",
    },
  });

  const store = new KvWorkerBuildArtifactStore(
    restKvNamespace(input) as unknown as KVNamespace,
    // Every deploy REWRITES the artifact (KV TTLs are fixed at write time —
    // a read never extends them), so the seed can be shorter-lived than
    // runtime artifacts; generous enough that a quiet env (no deploys for
    // days) keeps its fast creates.
    { expirationTtlSeconds: 14 * 24 * 60 * 60 },
  );
  const existing = await store.get(buildKey);
  if (existing !== null) {
    // Same bytes, fresh write-time TTL — skips the build without letting a
    // stable key's artifact quietly expire between deploys (which would
    // silently regress fresh-project birth to per-project container builds).
    await store.put(existing);
    log(`template worker artifact already seeded (${buildKey.slice(0, 12)}…) — TTL refreshed`);
    return { buildKey, seeded: false };
  }

  log(`building template worker artifact ${buildKey.slice(0, 12)}… on the host toolchain`);
  const result = await runWorkerBuildRecipeOnHost(workerBuildRecipe({ files, options }));
  if (result.status === "build-failed") {
    // A template that does not build means every fresh project is broken —
    // fail the deploy, never ship it.
    throw new Error(`template worker build failed:\n${result.message}`);
  }
  const artifact: WorkerBuildArtifact = {
    buildKey,
    mainModule: result.mainModule,
    modules: result.modules,
  };
  await store.put(artifact);
  log(
    `seeded template worker artifact ${buildKey.slice(0, 12)}… ` +
      `(${Object.keys(result.modules).length} modules)`,
  );
  return { buildKey, seeded: true };
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
