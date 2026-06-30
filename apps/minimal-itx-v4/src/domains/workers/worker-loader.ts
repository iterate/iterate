import { env } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerRef, DynamicWorkerSource } from "../../types.ts";
import { stableSha256 } from "./utils.ts";

const WORKER_COMPATIBILITY_DATE = "2026-05-01";

/**
 * Fully materialized Worker Loader input plus a cache key for the source bytes.
 * The cache key is source identity only; runtime scope and exported symbol are
 * added by `loadResolvedWorker` so the same source can be used in multiple ITX
 * paths without leaking bindings or entrypoint props across scopes.
 */
export type ResolvedWorkerSource = {
  cacheKey: string;
  mainModule: string;
  modules: Record<string, string>;
};

export type WorkerBindings = Record<string, unknown>;

export async function resolveWorkerSource({
  projectId,
  source,
}: {
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<ResolvedWorkerSource> {
  if (source.type === "inline") {
    return {
      cacheKey: await stableSha256({ source, type: "inline-worker-source" }),
      mainModule: source.mainModule,
      modules: source.modules,
    };
  }

  // Repo source is deliberately late-bound: a DynamicWorkerRef names "the worker file
  // at this repo path", not a frozen commit. That keeps source changes visible
  // on next use while the repo itself remains responsible for producing modules.
  const resolved = await env.REPO.getByName(
    DurableObjectNameCodec.stringify({
      projectId,
      path: source.repoPath,
    }),
  ).getWorkerSource({ path: source.sourcePath });

  return {
    ...resolved,
    cacheKey: await stableSha256({
      repoPath: source.repoPath,
      repoSourceCacheKey: resolved.cacheKey,
      sourcePath: source.sourcePath,
      type: "repo-worker-source",
    }),
  };
}

export function loadResolvedWorker({
  bindings,
  globalOutbound,
  loader,
  projectId,
  ref,
  resolved,
  workerScopeKey,
}: {
  bindings: WorkerBindings;
  globalOutbound: Fetcher;
  loader: WorkerLoader;
  projectId: string;
  ref: DynamicWorkerRef;
  resolved: ResolvedWorkerSource;
  workerScopeKey: string;
}): WorkerStub {
  // The Worker Loader cache must separate all runtime-relevant dimensions. In
  // particular `workerScopeKey` prevents a worker loaded for an agent path from
  // reusing a project-root `env.ITX` binding, even if the module bytes match.
  const exportKey =
    ref.type === "stateless"
      ? `entrypoint:${ref.entrypoint ?? "default"}`
      : `durable-object:${ref.className}`;
  const cacheKey = [
    "worker-loader",
    projectId,
    ref.path,
    workerScopeKey,
    ref.type,
    exportKey,
    resolved.cacheKey,
  ].join(":");
  return loader.get(cacheKey, () => ({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    env: bindings,
    globalOutbound,
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  }));
}
