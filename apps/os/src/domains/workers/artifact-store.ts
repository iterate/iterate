/**
 * Storage for loader-ready dynamic worker build output.
 *
 * Build output must never live in the stream event log; it lives behind this
 * store, addressed by the deterministic build key. Artifacts are
 * content-addressed and immutable: each key is written once and read by exact
 * key, which is the KV-friendly access pattern (no repeated updates of one
 * key), and `expirationTtl` gives cache expiry without a cleanup worker.
 */

// v4 adds host-served browser assets for the two-file app shape. The version
// prefix makes every older artifact layout unreachable; KV TTLs clean the
// orphans up.
export const WORKER_BUILD_ARTIFACT_SCHEMA_VERSION = 4;

/** Cache lifetime for build artifacts. Expiry only costs a rebuild on next
 * use. ("Reproducible" is approximate: npm ranges re-resolve at build time,
 * so a rebuild of the same key can pick newer dependency versions.) */
const WORKER_BUILD_ARTIFACT_TTL_SECONDS = 30 * 24 * 60 * 60;

const KV_PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

export type WorkerBuildArtifact = {
  assets: Record<string, string>;
  buildKey: string;
  mainModule: string;
  modules: Record<string, string>;
};

/**
 * The manifest is the artifact's presence marker and names its exact module
 * keys. Runtime loads read the manifest, then the named modules — prefix
 * listing stays a diagnostics/recovery tool, never the hot path.
 */
type WorkerBuildArtifactManifest = {
  assetNames: string[];
  /** Diagnostics only — never read back. */
  assetSizes: Record<string, number>;
  buildKey: string;
  createdAt: string;
  mainModule: string;
  moduleNames: string[];
  /** Diagnostics only — never read back. */
  moduleSizes: Record<string, number>;
  schemaVersion: typeof WORKER_BUILD_ARTIFACT_SCHEMA_VERSION;
};

function manifestKey(buildKey: string) {
  return `${KV_PREFIX}/${buildKey}/manifest.json`;
}

function moduleKey(buildKey: string, moduleName: string) {
  return `${KV_PREFIX}/${buildKey}/modules/${encodeURIComponent(moduleName)}`;
}

function assetKey(buildKey: string, pathname: string) {
  return `${KV_PREFIX}/${buildKey}/assets/${encodeURIComponent(pathname)}`;
}

/** How long an in-flight marker suppresses duplicate budgeted builds. Long
 * enough to cover dependency installation and bundling, but short enough
 * that a crashed build only delays budgeted callers rather than blocking
 * them forever (the artifact write always wins over the marker). */
const BUILD_IN_FLIGHT_TTL_SECONDS = 360;

function inFlightKey(buildKey: string) {
  return `${KV_PREFIX}/${buildKey}/building`;
}

/**
 * How long a recorded build failure short-circuits every caller without
 * re-running the failed build. A build key is content-addressed, so a genuine
 * compile/install failure is deterministic for that key and a fix always
 * commits a NEW key — the TTL exists only so a transient failure mislabelled
 * as genuine (npm weather during install) heals on its own. It must be LONG:
 * abandoned projects with broken heads retry delivery forever, and each TTL
 * expiry costs another full dependency install and bundle. Fifteen minutes
 * bounds that retry load while still letting a transient registry failure
 * heal without a source change.
 */
const BUILD_FAILURE_TTL_SECONDS = 15 * 60;

function buildFailureKey(buildKey: string) {
  return `${KV_PREFIX}/${buildKey}/failed`;
}

/** What went wrong building one exact build key — the record the serve-side
 * overlay shows a browser when the platform falls back to a previous build. */
export type WorkerBuildFailure = {
  at: string;
  /** The commit whose build failed (absent for inline sources). */
  commitOid?: string;
  message: string;
};

/**
 * The build genuinely ran and failed — the message is the bundler's own
 * error (validation, compile errors, unresolvable dependencies). The direct
 * build backend applies this name only around the worker-bundler operation;
 * repo, cache, and host-operation errors remain outside it. Name-based
 * matching because the error crosses Workers RPC (which preserves
 * `error.name` but not class identity). Lives here (not worker-loader.ts)
 * because this module must not import the loader's env.
 */
export class WorkerBuildFailedError extends Error {
  override readonly name = "WorkerBuildFailedError";
}

export function isWorkerBuildFailedError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "WorkerBuildFailedError";
}

/**
 * Bundler error dumps scale with error count and quote user-controlled
 * source; the message travels in a response header on every stale-serving
 * request, so it must stay a small bounded string.
 */
const BUILD_FAILURE_MESSAGE_LIMIT = 2_000;

export function buildFailureMessageFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > BUILD_FAILURE_MESSAGE_LIMIT
    ? `${message.slice(0, BUILD_FAILURE_MESSAGE_LIMIT)}… (truncated)`
    : message;
}

/**
 * The per-worker "previous good build" pointer — the ONE mutable record in
 * this store (everything else is content-addressed). Keyed by worker identity
 * (project + repo path + build options — see workerLastGoodKey), it names the
 * newest artifact that built successfully so the fetch lane can keep serving
 * it while a newer commit builds or after that build fails.
 */
export type WorkerLastGoodBuild = {
  at: string;
  buildKey: string;
  /** The commit the pointed-at artifact was built from (when known). */
  commitOid?: string;
};

function lastGoodKey(workerKey: string) {
  return `worker-last-good/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}/${workerKey}`;
}

/** `get` returns null on any incomplete artifact (no manifest, or a listed
 * module/asset missing): both are cache misses that a rebuild from the
 * deterministic input repairs. */
export class KvWorkerBuildArtifactStore {
  constructor(
    readonly kv: KVNamespace,
    readonly options: { expirationTtlSeconds?: number } = {},
  ) {}

  /**
   * Best-effort duplicate-build suppression for BUDGETED callers only: the
   * building-page refresh loop would otherwise dispatch a fresh full build
   * every ~18s per open tab while a slow cold build runs. Budgeted callers
   * can answer "still building" from the marker without work; blocking
   * callers ignore it (they need a result and idempotent duplicate builds
   * are their fallback — waiting on ANOTHER isolate's build via this marker
   * was tried and reverted: KV negative-caches the missing artifact key per
   * colo, so waiters stall instead of converging; worker-loader's stampede
   * guard is in-isolate only). Best-effort because KV propagation is
   * eventually consistent — a missed marker just means a duplicate build.
   */
  async isBuildInFlight(buildKey: string): Promise<boolean> {
    return (await this.kv.get(inFlightKey(buildKey), "text")) !== null;
  }

  async markBuildInFlight(buildKey: string): Promise<void> {
    await this.kv.put(inFlightKey(buildKey), new Date().toISOString(), {
      expirationTtl: BUILD_IN_FLIGHT_TTL_SECONDS,
    });
  }

  /** The marker means "a build is actually running": a failed build clears it
   * so budgeted callers retry (or serve the recorded failure) instead of
   * waiting out a marker TTL that outlives the shorter-lived failure record.
   * Best-effort — the TTL remains the backstop for a crashed build. */
  async clearBuildInFlight(buildKey: string): Promise<void> {
    await this.kv.delete(inFlightKey(buildKey));
  }

  async getBuildFailure(buildKey: string): Promise<WorkerBuildFailure | null> {
    return await this.kv.get<WorkerBuildFailure>(buildFailureKey(buildKey), "json");
  }

  async putBuildFailure(buildKey: string, failure: WorkerBuildFailure): Promise<void> {
    await this.kv.put(buildFailureKey(buildKey), JSON.stringify(failure), {
      expirationTtl: BUILD_FAILURE_TTL_SECONDS,
    });
  }

  async getLastGood(workerKey: string): Promise<WorkerLastGoodBuild | null> {
    return await this.kv.get<WorkerLastGoodBuild>(lastGoodKey(workerKey), "json");
  }

  /** Pointer updates ride cold builds and once-per-isolate cache-hit notes
   * (see noteLastGoodBuild in worker-loader.ts) — never the per-request hot
   * path, which would trip KV's one-write-per-second-per-key limit. */
  async putLastGood(workerKey: string, record: WorkerLastGoodBuild): Promise<void> {
    await this.kv.put(lastGoodKey(workerKey), JSON.stringify(record), {
      expirationTtl: this.options.expirationTtlSeconds ?? WORKER_BUILD_ARTIFACT_TTL_SECONDS,
    });
  }

  async get(buildKey: string): Promise<WorkerBuildArtifact | null> {
    // The schema version already namespaces the KV key prefix and is hashed
    // into every build key, so a manifest read at this exact key needs no
    // further identity checks.
    const manifest = await this.kv.get<WorkerBuildArtifactManifest>(manifestKey(buildKey), "json");
    if (manifest === null) return null;

    const [moduleEntries, assetEntries] = await Promise.all([
      Promise.all(
        manifest.moduleNames.map(
          async (name) => [name, await this.kv.get(moduleKey(buildKey, name), "text")] as const,
        ),
      ),
      Promise.all(
        manifest.assetNames.map(
          async (name) => [name, await this.kv.get(assetKey(buildKey, name), "text")] as const,
        ),
      ),
    ]);
    const modules: Record<string, string> = {};
    for (const [name, content] of moduleEntries) {
      if (content === null) return null;
      modules[name] = content;
    }
    const assets: Record<string, string> = {};
    for (const [name, content] of assetEntries) {
      if (content === null) return null;
      assets[name] = content;
    }

    return { assets, buildKey, mainModule: manifest.mainModule, modules };
  }

  async put(artifact: WorkerBuildArtifact): Promise<void> {
    const expirationTtl = this.options.expirationTtlSeconds ?? WORKER_BUILD_ARTIFACT_TTL_SECONDS;

    // Content keys first, manifest last: a reader that finds the manifest may
    // rely on every listed module and asset having been written before it.
    await Promise.all([
      ...Object.entries(artifact.modules).map(([name, content]) =>
        this.kv.put(moduleKey(artifact.buildKey, name), content, { expirationTtl }),
      ),
      ...Object.entries(artifact.assets).map(([name, content]) =>
        this.kv.put(assetKey(artifact.buildKey, name), content, { expirationTtl }),
      ),
    ]);

    const manifest: WorkerBuildArtifactManifest = {
      assetNames: Object.keys(artifact.assets).sort(),
      assetSizes: Object.fromEntries(
        Object.entries(artifact.assets).map(([name, content]) => [name, content.length]),
      ),
      buildKey: artifact.buildKey,
      createdAt: new Date().toISOString(),
      mainModule: artifact.mainModule,
      moduleNames: Object.keys(artifact.modules).sort(),
      moduleSizes: Object.fromEntries(
        Object.entries(artifact.modules).map(([name, content]) => [name, content.length]),
      ),
      schemaVersion: WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
    };
    await this.kv.put(manifestKey(artifact.buildKey), JSON.stringify(manifest), { expirationTtl });
  }
}
