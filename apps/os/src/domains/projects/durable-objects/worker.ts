// The project's WORKER: the code in the project's iterate-config repo, run as
// a dynamically loaded Cloudflare worker. `itx.worker` (the cap) and project
// ingress both land on the entrypoint this module loads.
//
// Two halves, split by where they run:
//
// 1. `WorkerHost` — lives inside the Project Durable Object, the single
//    writer. It owns the build pipeline (clone the iterate-config repo into a
//    workspace → read/bundle → validate) and the checkout cache in DO storage
//    (10s freshness TTL, deduped background rebuilds). It answers "what is
//    the current worker code?"
//
// 2. The free functions (`workerCacheKey`, `withWorkerEnv`, the guards) —
//    pure helpers usable from ANY worker with a LOADER binding. Project
//    ingress is served by the stateless ProjectIngressEntrypoint, which asks
//    the DO for the current checkout and loads the isolate itself; the DO
//    only helps find the source code.
//
// The loaded isolate's environment is fixed here and nowhere else:
//   env.ITERATE    — project-scoped itx (the worker is cap #0's code)
//   env.STREAMS    — the project's streams capability
//   globalOutbound — PROJECT EGRESS (Law 5): bare fetch() inside the worker,
//                    including fetches from bundled npm dependencies, gets
//                    secret substitution and never sees secret material.
//
// Storage keys keep their historical "configWorker" strings — they are
// durable data in deployed DOs; only the code vocabulary changed.

import type { Fetcher } from "captun";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { Event } from "@iterate-com/shared/streams/types";
import type { RepoInfo } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { stripArtifactTokenQuery } from "~/domains/repos/artifacts.ts";
import { ITERATE_CONFIG_REPO_SLUG } from "~/domains/repos/iterate-config-repo.ts";
import type { ItxProps } from "~/itx/protocol.ts";
import type { ProjectEgressProps } from "~/itx/entrypoint.ts";
import type { StreamsCapabilityProps } from "~/domains/streams/entrypoints/streams-capability.ts";

export const WORKER_CONFIG_DIR = "/iterate-config";
export const WORKER_MAIN_MODULE = "worker.js";
const WORKER_CONFIG_WORKER_PATH = `${WORKER_CONFIG_DIR}/${WORKER_MAIN_MODULE}`;
const WORKER_COMPATIBILITY_DATE = "2026-04-27";
const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];
const WORKER_WORKSPACE_ID = "project-ingress";
// Durable storage keys — historical names, do not rename.
const CHECKOUT_STORAGE_KEY = "project.configWorker.checkout";
const READY_STORAGE_KEY = "project.configWorker.ready";
const REFRESHED_AT_STORAGE_KEY = "project.configWorker.refreshedAt";
const REFRESH_INTERVAL_MS = 10_000;

/** The shape the loaded worker's default export must satisfy. */
export type LoadedWorkerEntrypoint = {
  [key: string]: any;
  [Symbol.dispose]?(): void;
  fetch(request: Request): Response | Promise<Response>;
  /** Optional hook: receives every live event on the project's root stream. */
  processEvent?(input: { event: Event }): unknown | Promise<unknown>;
};

export type WorkerModule =
  | string
  | {
      cjs?: string;
      data?: ArrayBuffer;
      js?: string;
      json?: object;
      text?: string;
    };

/**
 * Worker code as built and stored: bindings are NOT wired yet (globalOutbound
 * is always null), so the shape stays serializable and a checkout can cross
 * the RPC boundary to whichever worker loads it.
 */
export type WorkerCode = {
  compatibilityDate: string;
  compatibilityFlags: string[];
  globalOutbound: null;
  mainModule: string;
  modules: Record<string, WorkerModule>;
};

/** Worker code with live bindings wired (`withWorkerEnv`), ready for LOADER. */
export type RunnableWorkerCode = Omit<WorkerCode, "globalOutbound"> & {
  env?: Record<string, unknown>;
  globalOutbound: Fetcher | null;
};

/** A built worker pinned to the iterate-config commit it came from. */
export type WorkerCheckout = {
  commitOid: string;
  workerCode: WorkerCode;
};

export type WorkerLoaderBinding = {
  get(
    name: string,
    getCode: () => RunnableWorkerCode | Promise<RunnableWorkerCode>,
  ): {
    getEntrypoint(): unknown;
  };
};

export type WorkerGit = {
  clone(input: Record<string, unknown>): Promise<unknown>;
  log(input: { depth: number; dir: string; ref: string }): Promise<Array<{ oid: string }>>;
  pull(input: Record<string, unknown>): Promise<unknown>;
  status(input: { dir: string }): Promise<unknown>;
};

export type WorkerWorkspaceStub = {
  cloudflareShellGit(): Promise<unknown>;
  cloudflareShellState(): Promise<Record<string, unknown>>;
  hasFile(path: string): Promise<boolean>;
  initialize(input: { name: string }): Promise<unknown>;
  removePath(input: { force: boolean; path: string; recursive: boolean }): Promise<void>;
};

export type WorkerWorkspace = {
  git: WorkerGit;
  workspace: WorkerWorkspaceStub;
};

/** The loopback exports every worker-loading site wires bindings from. */
export type WorkerLoopbackExports = Cloudflare.Exports & {
  ItxEntrypoint(input: { props: ItxProps }): Fetcher;
  ProjectEgress(input: { props: ProjectEgressProps }): Fetcher;
  StreamsCapability(input: { props: StreamsCapabilityProps }): Fetcher;
};

export function readLoopbackExports(exports: unknown): WorkerLoopbackExports {
  return exports as WorkerLoopbackExports;
}

/**
 * The loader cache key. Shared by every site that loads this worker (the DO
 * and the ingress entrypoint), so they all reuse the same warm isolate.
 * Historical "project-ingress:v4" prefix — changing it just forces a reload.
 */
export function workerCacheKey(input: { commitOid: string; projectId: string }) {
  return `project-ingress:v4:${input.projectId}:${input.commitOid}`;
}

/** Wire the fixed worker environment (see module header) into worker code. */
export function withWorkerEnv(input: {
  exports: WorkerLoopbackExports;
  projectId: string;
  workerCode: WorkerCode;
}): RunnableWorkerCode {
  return {
    ...input.workerCode,
    env: {
      ITERATE: input.exports.ItxEntrypoint({
        props: { cap: "worker", context: input.projectId },
      }),
      STREAMS: input.exports.StreamsCapability({
        props: { projectId: input.projectId },
      }),
    },
    globalOutbound: input.exports.ProjectEgress({
      props: { cap: "worker", context: input.projectId, project: input.projectId },
    }),
    modules: {
      ...input.workerCode.modules,
    },
  };
}

type WorkerProject = { id: string; slug: string };

export type WorkerHostDeps = {
  ctx: DurableObjectState;
  loader: WorkerLoaderBinding;
  workspaceNamespace: DurableObjectNamespace;
  /** Resolve the project's iterate-config repo (clone URL + auth token). */
  getRepo: (project: WorkerProject) => Promise<RepoInfo>;
  /** Clone the repo into the workspace. Overridable seam for tests. */
  cloneRepo: (input: WorkerWorkspace & { repo: RepoInfo }) => Promise<unknown>;
  /** Bundle a multi-file checkout (package.json present) into worker code. */
  bundle: (files: Record<string, string>) => Promise<WorkerCode>;
};

/**
 * DO-side build pipeline + checkout cache. One instance per Project DO; all
 * mutation of the checkout cache goes through here.
 */
export class WorkerHost {
  #deps: WorkerHostDeps;
  #entrypoint: { commitOid: string; entrypoint: LoadedWorkerEntrypoint } | null = null;
  #buildPromise: Promise<WorkerCheckout> | null = null;
  #buildChain: Promise<unknown> = Promise.resolve();

  constructor(deps: WorkerHostDeps) {
    this.#deps = deps;
  }

  /**
   * Dispatch semantics for ingress: serve the cached checkout while it is
   * fresh; when stale, kick off ONE background rebuild and keep serving the
   * stale checkout; report "building" only when nothing is cached yet.
   */
  async versionForDispatch(
    project: WorkerProject,
  ): Promise<{ status: "ready"; checkout: WorkerCheckout } | { status: "building" }> {
    if (await this.#checkoutIsFresh()) {
      const checkout = await this.getCachedCheckout();
      if (checkout) return { status: "ready", checkout };
    }

    const cached = await this.getCachedCheckout();
    if (this.#buildPromise === null) this.#startBackgroundBuild(project);
    return cached ? { status: "ready", checkout: cached } : { status: "building" };
  }

  /**
   * Clone, build, validate-load, and persist a fresh checkout. Builds are
   * SERIALIZED: every caller (background rebuilds, the creation step,
   * callWorkerFunction) shares one checkout directory in the workspace, so
   * overlapping clone/read cycles would corrupt each other.
   */
  buildFresh(project: WorkerProject): Promise<WorkerCheckout> {
    const build = this.#buildChain.then(
      () => this.#buildFresh(project),
      () => this.#buildFresh(project),
    );
    this.#buildChain = build.catch(() => {});
    return build;
  }

  async #buildFresh(project: WorkerProject): Promise<WorkerCheckout> {
    const checkout = await this.#checkoutFromRepo(project);
    this.load({ checkout, projectId: project.id });
    await this.#deps.ctx.storage.put(CHECKOUT_STORAGE_KEY, checkout);
    await this.#deps.ctx.storage.put(READY_STORAGE_KEY, true);
    await this.#deps.ctx.storage.put(REFRESHED_AT_STORAGE_KEY, Date.now());
    return checkout;
  }

  /** The persisted checkout, or null (clearing the cache) when invalid. */
  async getCachedCheckout(): Promise<WorkerCheckout | null> {
    const checkout = await this.#deps.ctx.storage.get<WorkerCheckout>(CHECKOUT_STORAGE_KEY);
    if (isWorkerCheckout(checkout)) return checkout;
    if (checkout !== undefined) {
      console.error("Cached worker checkout is invalid; clearing it.");
      await this.clearReady();
    }
    return null;
  }

  /** Whether a built worker is available for event forwarding. */
  async isReady(): Promise<boolean> {
    return (await this.#deps.ctx.storage.get<boolean>(READY_STORAGE_KEY)) === true;
  }

  async clearReady() {
    this.#entrypoint = null;
    await this.#deps.ctx.storage.delete(READY_STORAGE_KEY);
    await this.#deps.ctx.storage.delete(CHECKOUT_STORAGE_KEY);
    await this.#deps.ctx.storage.delete(REFRESHED_AT_STORAGE_KEY);
  }

  /**
   * Load a checkout into a live entrypoint, memoized per commit. The
   * entrypoint can never cross an RPC boundary (workerd forbids transferring
   * loader entrypoints), so callers replay paths against it in-process.
   */
  load(input: { checkout: WorkerCheckout; projectId: string }): LoadedWorkerEntrypoint {
    const { checkout } = input;
    if (this.#entrypoint?.commitOid === checkout.commitOid) {
      return this.#entrypoint.entrypoint;
    }

    const worker = this.#deps.loader.get(
      workerCacheKey({ commitOid: checkout.commitOid, projectId: input.projectId }),
      () =>
        withWorkerEnv({
          exports: readLoopbackExports(this.#deps.ctx.exports),
          projectId: input.projectId,
          workerCode: checkout.workerCode,
        }),
    );
    const entrypoint = worker.getEntrypoint();
    if (!isLoadedWorkerEntrypoint(entrypoint)) {
      throw new Error("Loaded worker entrypoint is missing fetch.");
    }

    this.#entrypoint = { commitOid: checkout.commitOid, entrypoint };
    return entrypoint;
  }

  #startBackgroundBuild(project: WorkerProject) {
    const buildPromise = this.buildFresh(project);
    this.#buildPromise = buildPromise;
    this.#deps.ctx.waitUntil(
      buildPromise
        .catch((error) => {
          console.error("Worker build failed.", error);
        })
        .finally(() => {
          if (this.#buildPromise === buildPromise) this.#buildPromise = null;
        }),
    );
  }

  async #checkoutIsFresh() {
    const refreshedAt = await this.#deps.ctx.storage.get<number>(REFRESHED_AT_STORAGE_KEY);
    return (
      typeof refreshedAt === "number" &&
      Number.isFinite(refreshedAt) &&
      Date.now() - refreshedAt < REFRESH_INTERVAL_MS
    );
  }

  async #checkoutFromRepo(project: WorkerProject): Promise<WorkerCheckout> {
    const repo = await this.#deps.getRepo(project);
    const { git, workspace } = await this.#getWorkspace(project.id);

    await workspace.removePath({ force: true, path: WORKER_CONFIG_DIR, recursive: true });
    await this.#deps.cloneRepo({ git, repo, workspace });

    const [commit] = await git.log({ dir: WORKER_CONFIG_DIR, depth: 1, ref: "HEAD" });
    if (!commit) {
      throw new Error("Worker iterate-config checkout does not have a HEAD commit.");
    }

    const state = await workspace.cloudflareShellState();
    const files = await readWorkerFiles(state);
    const workerSource = files[WORKER_MAIN_MODULE];
    if (typeof workerSource !== "string" || workerSource.trim() === "") {
      throw new Error(`${ITERATE_CONFIG_REPO_SLUG} repo is missing ${WORKER_MAIN_MODULE}.`);
    }
    const workerCode =
      typeof files["package.json"] === "string" && files["package.json"].trim() !== ""
        ? await this.#deps.bundle(files)
        : plainWorkerCode(workerSource);

    return { commitOid: commit.oid, workerCode };
  }

  async #getWorkspace(projectId: string): Promise<WorkerWorkspace> {
    const durableObjectName = deriveDurableObjectNameFromStructuredName({
      structuredName: { projectId, workspaceId: WORKER_WORKSPACE_ID },
    });
    const workspace = this.#deps.workspaceNamespace.getByName(
      durableObjectName,
    ) as unknown as WorkerWorkspaceStub;
    await workspace.initialize({ name: durableObjectName });

    return {
      git: (await workspace.cloudflareShellGit()) as unknown as WorkerGit,
      workspace,
    };
  }
}

export function cloneWorkerRepo(input: WorkerWorkspace & { repo: RepoInfo }) {
  return input.git.clone({
    url: input.repo.remote,
    dir: WORKER_CONFIG_DIR,
    branch: input.repo.defaultBranch,
    depth: 1,
    username: "x",
    password: stripArtifactTokenQuery(input.repo.token),
  });
}

function plainWorkerCode(source: string): WorkerCode {
  return {
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    globalOutbound: null,
    mainModule: WORKER_MAIN_MODULE,
    modules: {
      [WORKER_MAIN_MODULE]: { js: source },
    },
  };
}

export async function bundleWorkerCode(files: Record<string, string>): Promise<WorkerCode> {
  const { createWorker } = await import("@cloudflare/worker-bundler");
  const result = await createWorker({
    entryPoint: WORKER_MAIN_MODULE,
    files,
  });

  for (const warning of result.warnings ?? []) {
    console.warn(`Worker bundler warning: ${warning}`);
  }

  return {
    compatibilityDate: result.wranglerConfig?.compatibilityDate ?? WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: result.wranglerConfig?.compatibilityFlags ?? WORKER_COMPATIBILITY_FLAGS,
    globalOutbound: null,
    mainModule: result.mainModule,
    modules: result.modules,
  };
}

async function readWorkerFiles(state: Record<string, unknown>): Promise<Record<string, string>> {
  const readFile = state.readFile;
  if (typeof readFile !== "function") {
    throw new Error("Worker workspace state does not implement readFile.");
  }
  const readTextFile = readFile as (...args: unknown[]) => unknown;

  const find = state.find;
  if (typeof find !== "function") {
    const workerSource = await readWorkspaceTextFile(readTextFile, WORKER_CONFIG_WORKER_PATH);
    const packageJson = await readOptionalWorkspaceTextFile(
      readTextFile,
      `${WORKER_CONFIG_DIR}/package.json`,
    );
    return packageJson === null
      ? { [WORKER_MAIN_MODULE]: workerSource }
      : { [WORKER_MAIN_MODULE]: workerSource, "package.json": packageJson };
  }

  const entries = (await find(WORKER_CONFIG_DIR, { type: "file" })) as Array<{ path?: unknown }>;
  const files: Record<string, string> = {};

  for (const entry of entries) {
    if (typeof entry.path !== "string") continue;
    const relativePath = workerRelativePath(entry.path);
    if (relativePath === null) continue;

    files[relativePath] = await readWorkspaceTextFile(readTextFile, entry.path);
  }

  return files;
}

function workerRelativePath(path: string) {
  if (!path.startsWith(`${WORKER_CONFIG_DIR}/`)) return null;

  const relativePath = path.slice(WORKER_CONFIG_DIR.length + 1);
  if (
    relativePath === "" ||
    relativePath.startsWith(".git/") ||
    relativePath.startsWith("node_modules/")
  ) {
    return null;
  }

  return relativePath;
}

async function readWorkspaceTextFile(
  readFile: (...args: unknown[]) => unknown,
  path: string,
): Promise<string> {
  const content = await readFile(path);
  if (typeof content !== "string") {
    throw new Error(`Worker workspace file ${path} did not contain text.`);
  }

  return content;
}

async function readOptionalWorkspaceTextFile(
  readFile: (...args: unknown[]) => unknown,
  path: string,
) {
  try {
    return await readWorkspaceTextFile(readFile, path);
  } catch (error) {
    if (isFileMissingError(error)) return null;
    throw error;
  }
}

export function isLoadedWorkerEntrypoint(value: unknown): value is LoadedWorkerEntrypoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

function isWorkerCheckout(value: unknown): value is WorkerCheckout {
  return (
    typeof value === "object" &&
    value !== null &&
    "commitOid" in value &&
    typeof value.commitOid === "string" &&
    value.commitOid.length > 0 &&
    "workerCode" in value &&
    isWorkerCode(value.workerCode)
  );
}

function isWorkerCode(value: unknown): value is WorkerCode {
  return (
    typeof value === "object" &&
    value !== null &&
    "compatibilityDate" in value &&
    typeof value.compatibilityDate === "string" &&
    "compatibilityFlags" in value &&
    Array.isArray(value.compatibilityFlags) &&
    value.compatibilityFlags.every((flag) => typeof flag === "string") &&
    "globalOutbound" in value &&
    value.globalOutbound === null &&
    "mainModule" in value &&
    typeof value.mainModule === "string" &&
    "modules" in value &&
    typeof value.modules === "object" &&
    value.modules !== null
  );
}

function isFileMissingError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("could not find") ||
    message.includes("no such file")
  );
}
