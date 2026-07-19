/**
 * Deploy-time template artifact seeding — the TRUSTED build-key tier's only
 * writer (see build-key.ts).
 *
 * Every fresh project seeds its config repo from one deterministic template.
 * The deploy host prebuilds both template recipes under content-only trusted
 * keys: the root worker needed during project birth and the example Vite app.
 * Fresh projects therefore never cold-build repo-owned template code inside a
 * request; the project-scoped container lane remains for real config edits.
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

const PACKAGE_READINESS_TIMEOUT_MS = 60_000;
const PACKAGE_READINESS_POLL_INTERVAL_MS = 1_000;
const PACKAGE_READINESS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Wait for pkg.pr.new's immutable commit tarball to become readable.
 *
 * Preview deploy and package publication are independent workflows. The URL
 * is therefore the authoritative synchronization point: a completed GitHub
 * job can still precede CDN visibility, while a 200 here is exactly what the
 * following npm install needs. Only publication-shaped outcomes retry, and
 * the wait is bounded so a failed publisher cannot stall a deploy forever.
 */
export async function waitForPublishedPackage(input: {
  packageSpec: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  const fetchPackage = input.fetch ?? fetch;
  const log = input.log ?? console.log;
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? PACKAGE_READINESS_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? PACKAGE_READINESS_POLL_INTERVAL_MS;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastOutcome = "not checked";
  let announcedWait = false;

  while (true) {
    const remainingBeforeAttempt = deadline - now();
    if (attempts > 0 && remainingBeforeAttempt <= 0) {
      throw new Error(
        `Package ${input.packageSpec} was not published within ${timeoutMs}ms (${lastOutcome}).`,
      );
    }

    attempts += 1;
    let response: Response | undefined;
    try {
      response = await fetchPackage(input.packageSpec, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(PACKAGE_READINESS_REQUEST_TIMEOUT_MS, remainingBeforeAttempt)),
        ),
      });
    } catch (error) {
      lastOutcome = `request failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (response?.ok) {
      if (announcedWait) {
        log(
          `package artifact available after ${((now() - startedAt) / 1_000).toFixed(1)}s ` +
            `(${attempts} attempts): ${input.packageSpec}`,
        );
      }
      return;
    }

    if (response) {
      lastOutcome = `HTTP ${response.status}`;
      if (response.status !== 404 && response.status !== 429 && response.status < 500) {
        throw new Error(`Package readiness check failed for ${input.packageSpec}: ${lastOutcome}.`);
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `Package ${input.packageSpec} was not published within ${timeoutMs}ms (${lastOutcome}).`,
      );
    }
    if (!announcedWait) {
      announcedWait = true;
      log(
        `package artifact is not published yet (${lastOutcome}); waiting up to ` +
          `${timeoutMs}ms: ${input.packageSpec}`,
      );
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

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
      label: "TanStack app",
      options: { pipeline: "vite", rootDir: "apps/tanstack" },
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
  const seeded: Array<{ buildKey: string; seeded: boolean }> = [];
  let publishedPackageReady = false;
  for (const build of builds) {
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
      seeded.push({ buildKey, seeded: false });
      continue;
    }

    // pkg.pr.new publishes independently from preview deploys. Synchronize on
    // its immutable URL once, immediately before the first missing artifact;
    // an all-cache-hit deploy performs no publication wait.
    if (!publishedPackageReady && input.iterateSdkPackageSpec?.startsWith("https://pkg.pr.new/")) {
      await waitForPublishedPackage({
        packageSpec: input.iterateSdkPackageSpec,
        log,
      });
      publishedPackageReady = true;
    }

    log(
      `building ${build.label} template artifact ${buildKey.slice(0, 12)}… on the host toolchain`,
    );
    const result = await runWorkerBuildRecipeOnHost(workerBuildRecipe({ files, options }));
    if (result.status === "build-failed") {
      // A broken deterministic template would break every fresh project.
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
    seeded.push({ buildKey, seeded: true });
  }
  return seeded;
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
