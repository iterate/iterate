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

/** Cache lifetime for build artifacts. Every artifact is reproducible from its
 * deterministic build key, so expiry only costs a rebuild on next use. */
export const WORKER_BUILD_ARTIFACT_TTL_SECONDS = 30 * 24 * 60 * 60;

const KV_PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

export type WorkerBuildArtifact = {
  buildKey: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
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
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  createdAt: string;
  mainModule: string;
  moduleNames: string[];
  moduleSizes: Record<string, number>;
  schemaVersion: typeof WORKER_BUILD_ARTIFACT_SCHEMA_VERSION;
};

export interface WorkerBuildArtifactStore {
  /** Null on any incomplete artifact (no manifest, or a listed module missing):
   * both are cache misses that a rebuild from the deterministic input repairs. */
  get(buildKey: string): Promise<WorkerBuildArtifact | null>;
  put(artifact: WorkerBuildArtifact): Promise<void>;
}

function manifestKey(buildKey: string) {
  return `${KV_PREFIX}/${buildKey}/manifest.json`;
}

function moduleKey(buildKey: string, moduleName: string) {
  return `${KV_PREFIX}/${buildKey}/modules/${encodeURIComponent(moduleName)}`;
}

export class KvWorkerBuildArtifactStore implements WorkerBuildArtifactStore {
  constructor(
    readonly kv: KVNamespace,
    readonly options: { expirationTtlSeconds?: number } = {},
  ) {}

  async get(buildKey: string): Promise<WorkerBuildArtifact | null> {
    const manifest = await this.kv.get<WorkerBuildArtifactManifest>(manifestKey(buildKey), "json");
    if (
      manifest === null ||
      manifest.schemaVersion !== WORKER_BUILD_ARTIFACT_SCHEMA_VERSION ||
      manifest.buildKey !== buildKey
    ) {
      return null;
    }

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

    return {
      buildKey,
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      mainModule: manifest.mainModule,
      modules,
    };
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
      compatibilityDate: artifact.compatibilityDate,
      compatibilityFlags: artifact.compatibilityFlags,
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

/** Test double with the same manifest-last write discipline made observable. */
export class InMemoryWorkerBuildArtifactStore implements WorkerBuildArtifactStore {
  readonly artifacts = new Map<string, WorkerBuildArtifact>();

  async get(buildKey: string): Promise<WorkerBuildArtifact | null> {
    return this.artifacts.get(buildKey) ?? null;
  }

  async put(artifact: WorkerBuildArtifact): Promise<void> {
    this.artifacts.set(artifact.buildKey, structuredClone(artifact));
  }
}
