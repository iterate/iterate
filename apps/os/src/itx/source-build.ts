// Repo-sourced worker code: resolve `{ type: "repo" }` sources to built
// modules. `build(repo@sha, path, bundle) → modules` is a pure function, so
// its output is a MEMO, never an address — three tiers, one key:
//
//   repo (the authority) → R2 (`ITX_BUILD_CACHE`, hash-keyed immutable
//   bundles, evictable because every entry is reproducible from its key)
//   → the Worker Loader's isolate cache (ephemeral).
//
// Builds happen per COMMIT — never per call, never on a warm dial. Bundling
// runs in-process on an in-memory vfs (@cloudflare/worker-bundler /
// esbuild-wasm): repo DO readTree → vfs → R2. No clone, no workspace, no
// filesystem.

import type { WorkerSource } from "./itx.ts";
import type { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { getRepoDurableObjectName } from "~/domains/repos/repo-durable-object-name.ts";
import { RepoEmptyError } from "~/domains/repos/repo-errors.ts";

/**
 * The checkout has no file at the source's path — a NORMAL "there is no
 * worker yet" state, as opposed to a transient build/git failure. Workers
 * RPC preserves `error.name`, so classifiers (isMissingProjectWorkerError)
 * match by name even across the repo-DO hop.
 */
export class MissingProjectWorkerError extends Error {
  override readonly name = "MissingProjectWorkerError";
}

/** Worker code ready for the Worker Loader: the universal shape every source
 * kind resolves to. For repo sources `cacheKey` is the R2 memo key. */
export type ResolvedWorkerCode = {
  cacheKey: string;
  mainModule: string;
  modules: Record<string, unknown>;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
};

export type SourceBuildEnv = {
  ITX_BUILD_CACHE?: R2Bucket;
  REPO?: DurableObjectNamespace<RepoDurableObject>;
};

// "latest" resolves to a sha at most once per window per isolate — the
// successor of the old checkout-freshness TTL. Event forwarding passes
// `latestMaxAgeMs: 0` (exact: an event can be the direct consequence of a
// config push, and serving the previous worker would consume the very
// trigger the new config exists to handle).
const LATEST_PROBE_WINDOW_MS = 10_000;
const latestProbes = new Map<string, { at: number; oid: string }>();

// Concurrent dials of a cold key share ONE build instead of stampeding.
const inFlightBuilds = new Map<string, Promise<ResolvedWorkerCode>>();

/**
 * Resolve any {@link WorkerSource} to loader-ready code. Inline sources are
 * already code (synchronous identity); repo sources go through the memo.
 */
export function resolveWorkerSource(input: {
  env: SourceBuildEnv;
  projectId: string;
  source: WorkerSource;
  /** Max staleness of the "latest"-commit probe; 0 probes the remote now. */
  latestMaxAgeMs?: number;
}): ResolvedWorkerCode | Promise<ResolvedWorkerCode> {
  const { source } = input;
  if (source.type === "inline") {
    return {
      cacheKey: source.cacheKey,
      compatibilityDate: source.compatibilityDate,
      mainModule: source.mainModule,
      modules: source.modules,
    };
  }
  return resolveRepoSource({ ...input, source });
}

async function resolveRepoSource(input: {
  env: SourceBuildEnv;
  projectId: string;
  source: WorkerSource & { type: "repo" };
  latestMaxAgeMs?: number;
}): Promise<ResolvedWorkerCode> {
  const { env, projectId, source } = input;
  if (!env.REPO || !env.ITX_BUILD_CACHE) {
    throw new Error("Repo-sourced workers need REPO and ITX_BUILD_CACHE bindings on this host.");
  }
  const cache = env.ITX_BUILD_CACHE;
  const repo = env.REPO.getByName(
    getRepoDurableObjectName({ path: source.repoPath, projectId }),
  ) as unknown as RepoDurableObject;

  const oid =
    source.commit === "latest"
      ? await latestOid({
          key: `${projectId}:${source.repoPath}`,
          maxAgeMs: input.latestMaxAgeMs ?? LATEST_PROBE_WINDOW_MS,
          repo,
        })
      : source.commit;
  const memoKey = await repoSourceMemoKey({ oid, projectId, source });

  const hit = await cache.get(memoKey);
  if (hit) return { cacheKey: memoKey, ...((await hit.json()) as StoredBuild) };

  const pending = inFlightBuilds.get(memoKey);
  if (pending) return pending;
  const build = buildAndMemoize({ cache, memoKey, oid, projectId, repo, source }).finally(() =>
    inFlightBuilds.delete(memoKey),
  );
  inFlightBuilds.set(memoKey, build);
  return await build;
}

type StoredBuild = Omit<ResolvedWorkerCode, "cacheKey">;

async function buildAndMemoize(input: {
  cache: R2Bucket;
  memoKey: string;
  oid: string;
  projectId: string;
  repo: RepoDurableObject;
  source: WorkerSource & { type: "repo" };
}): Promise<ResolvedWorkerCode> {
  const { source } = input;
  // Pinned commits check out the sha itself; "latest" checks out the default
  // branch — and the checkout's OWN head oid is the truth (a push can land
  // between the probe and the checkout; the build is filed under what was
  // actually read).
  const tree = await input.repo.readTree(source.commit === "latest" ? {} : { ref: source.commit });
  const memoKey =
    tree.commitOid === input.oid
      ? input.memoKey
      : await repoSourceMemoKey({ oid: tree.commitOid, projectId: input.projectId, source });

  const stored = await buildFromTree({ files: tree.files, oid: tree.commitOid, source });
  // The memo is an optimization; a failed write must not fail the dial that
  // just built perfectly good code (the next cold dial rebuilds).
  try {
    await input.cache.put(memoKey, JSON.stringify(stored));
  } catch (error) {
    console.warn(`[itx build] memo write failed for ${memoKey}:`, error);
  }
  return { cacheKey: memoKey, ...stored };
}

async function buildFromTree(input: {
  files: Array<{ content: string; path: string }>;
  oid: string;
  source: WorkerSource & { type: "repo" };
}): Promise<StoredBuild> {
  const { source } = input;
  const files = withIterateWorkerPackage(
    Object.fromEntries(input.files.map((file) => [file.path, file.content])),
  );

  // Typed for BOTH branches: a missing/empty entry file is the normal
  // "no worker yet" state, never a build failure (the bundler would surface
  // it as an opaque resolve error otherwise).
  const content = files[source.path];
  if (typeof content !== "string" || content.trim() === "") {
    throw new MissingProjectWorkerError(
      `${source.repoPath}@${input.oid.slice(0, 8)} has no file at "${source.path}".`,
    );
  }

  if (!source.bundle) {
    return {
      compatibilityDate: source.compatibilityDate,
      mainModule: source.path,
      modules: { [source.path]: content },
    };
  }

  const { createWorker } = await import("@cloudflare/worker-bundler");
  const result = await createWorker({
    entryPoint: source.path,
    externals: source.bundle.externals,
    files,
    minify: source.bundle.minify,
  });
  for (const warning of result.warnings ?? []) {
    console.warn(
      `[itx build] ${source.repoPath}@${input.oid.slice(0, 8)} ${source.path}: ${warning}`,
    );
  }
  return {
    compatibilityDate: source.compatibilityDate ?? result.wranglerConfig?.compatibilityDate,
    compatibilityFlags: result.wranglerConfig?.compatibilityFlags,
    mainModule: result.mainModule,
    // Binary asset modules (ArrayBuffer data) cannot ride the JSON memo;
    // nothing produces them today, so refuse loudly rather than corrupt.
    modules: assertJsonSafeModules(result.modules, source),
  };
}

async function latestOid(input: {
  key: string;
  maxAgeMs: number;
  repo: RepoDurableObject;
}): Promise<string> {
  const cached = latestProbes.get(input.key);
  if (cached && Date.now() - cached.at < input.maxAgeMs) return cached.oid;
  const { oid } = await input.repo.headOid();
  if (!oid) throw new RepoEmptyError(`Repo "${input.key}" has no head commit to build from.`);
  latestProbes.set(input.key, { at: Date.now(), oid });
  return oid;
}

/** The cache key IS the address: hash(project, repoPath, sha, path, bundle,
 * compatibilityDate — it changes the stored build). Exported for tests that
 * pre-seed the memo. */
export async function repoSourceMemoKey(input: {
  oid: string;
  projectId: string;
  source: WorkerSource & { type: "repo" };
}): Promise<string> {
  const { source } = input;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        input.projectId,
        source.repoPath,
        input.oid,
        source.path,
        source.bundle ?? null,
        source.compatibilityDate ?? null,
        ITERATE_WORKER_PACKAGE_FILES,
      ]),
    ),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `build/${hex}`;
}

function assertJsonSafeModules(
  modules: Record<string, unknown>,
  source: { repoPath: string; path: string },
): Record<string, unknown> {
  for (const [path, module] of Object.entries(modules)) {
    if (typeof module === "string") continue;
    if (module && typeof module === "object" && !("data" in module)) continue;
    throw new Error(
      `Build of ${source.repoPath}:${source.path} produced a binary module ("${path}") — ` +
        `binary assets are not supported in repo sources yet.`,
    );
  }
  return modules;
}

const ITERATE_WORKER_PACKAGE_FILES: Record<string, string> = {
  "node_modules/iterate/package.json": JSON.stringify({
    exports: {
      "./worker": "./worker.ts",
    },
    name: "iterate",
    type: "module",
    version: "0.0.0-iterate-platform",
  }),
  "node_modules/iterate/worker.ts": iterateWorkerPackageSource(),
};

function iterateWorkerPackageSource() {
  return `import { WorkerEntrypoint } from "cloudflare:workers";

export type IterateStreamAppendInput = {
  event: unknown;
  streamPath?: string;
};

export type IterateProjectStreams = {
  append: (input: IterateStreamAppendInput) => Promise<unknown>;
};

export type IterateProjectItx<Context = unknown> = {
  context: Promise<Context>;
};

export type IterateProjectEnv<Context = unknown> = {
  ITERATE: IterateProjectItx<Context>;
  STREAMS: IterateProjectStreams;
};

export type IterateProjectEventInput = {
  event: unknown;
  streamPath: string;
};

export class IterateProjectEntrypoint<Context = unknown> extends WorkerEntrypoint<
  IterateProjectEnv<Context>
> {
  get itx(): IterateProjectItx<Context> {
    return this.env.ITERATE;
  }

  get streams(): IterateProjectEnv["STREAMS"] {
    return this.env.STREAMS;
  }

  async processEvent(input: IterateProjectEventInput): Promise<void> {
    await this.onProjectEvent(input);
  }

  protected async onProjectEvent(_input: IterateProjectEventInput): Promise<void> {}
}
`;
}

function withIterateWorkerPackage(files: Record<string, string>): Record<string, string> {
  return {
    ...ITERATE_WORKER_PACKAGE_FILES,
    ...files,
  };
}
