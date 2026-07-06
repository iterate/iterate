/**
 * Storage for loader-ready dynamic worker build output.
 *
 * Build output must never live in the stream event log; it lives behind this
 * store, addressed by the deterministic build key. Artifacts are
 * content-addressed and immutable: each key is written once and read by exact
 * key, which is the KV-friendly access pattern (no repeated updates of one
 * key), and `expirationTtl` gives cache expiry without a cleanup worker.
 */

export const WORKER_BUILD_ARTIFACT_SCHEMA_VERSION = 1;

/** Cache lifetime for build artifacts. Expiry only costs a rebuild on next
 * use. ("Reproducible" is approximate: npm ranges re-resolve at build time,
 * so a rebuild of the same key can pick newer dependency versions.) */
const WORKER_BUILD_ARTIFACT_TTL_SECONDS = 30 * 24 * 60 * 60;

const KV_PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

export type WorkerBuildArtifact = {
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

/** How long an in-flight marker suppresses duplicate budgeted builds. Long
 * enough to cover a cold npm-install build; short enough that a crashed
 * builder only delays budgeted callers, never blocks them forever (the
 * artifact write always wins over the marker). */
const BUILD_IN_FLIGHT_TTL_SECONDS = 180;

function inFlightKey(buildKey: string) {
  return `${KV_PREFIX}/${buildKey}/building`;
}

/** `get` returns null on any incomplete artifact (no manifest, or a listed
 * module missing): both are cache misses that a rebuild from the
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
   * are their fallback). Best-effort because KV propagation is eventually
   * consistent — a missed marker just means today's duplicate-build
   * behavior.
   */
  async isBuildInFlight(buildKey: string): Promise<boolean> {
    return (await this.kv.get(inFlightKey(buildKey), "text")) !== null;
  }

  async markBuildInFlight(buildKey: string): Promise<void> {
    await this.kv.put(inFlightKey(buildKey), new Date().toISOString(), {
      expirationTtl: BUILD_IN_FLIGHT_TTL_SECONDS,
    });
  }

  async get(buildKey: string): Promise<WorkerBuildArtifact | null> {
    // The schema version already namespaces the KV key prefix and is hashed
    // into every build key, so a manifest read at this exact key needs no
    // further identity checks.
    const manifest = await this.kv.get<WorkerBuildArtifactManifest>(manifestKey(buildKey), "json");
    if (manifest === null) return null;

    const moduleEntries = await Promise.all(
      manifest.moduleNames.map(
        async (name) => [name, await this.kv.get(moduleKey(buildKey, name), "text")] as const,
      ),
    );
    const modules: Record<string, string> = {};
    for (const [name, content] of moduleEntries) {
      if (content === null) return null;
      modules[name] = content;
    }

    return { buildKey, mainModule: manifest.mainModule, modules };
  }

  async put(artifact: WorkerBuildArtifact): Promise<void> {
    const expirationTtl = this.options.expirationTtlSeconds ?? WORKER_BUILD_ARTIFACT_TTL_SECONDS;

    // Module keys first, manifest last: a reader that finds the manifest may
    // rely on every listed module having been written before it.
    await Promise.all(
      Object.entries(artifact.modules).map(([name, content]) =>
        this.kv.put(moduleKey(artifact.buildKey, name), content, { expirationTtl }),
      ),
    );

    const manifest: WorkerBuildArtifactManifest = {
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
