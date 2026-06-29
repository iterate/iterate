import { env } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { WorkerRef, WorkerSource } from "./types.ts";

export const WORKER_COMPATIBILITY_DATE = "2026-05-01";

export type ResolvedWorkerSource = {
  cacheKey: string;
  mainModule: string;
  modules: Record<string, string>;
};

export type WorkerBindings = Record<string, unknown>;

export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function resolveWorkerSource({
  projectId,
  source,
}: {
  projectId: string;
  source: WorkerSource;
}): Promise<ResolvedWorkerSource> {
  if (source.type === "inline") {
    return {
      cacheKey: hashString(JSON.stringify(source)),
      mainModule: source.mainModule,
      modules: source.modules,
    };
  }

  const resolved = await env.REPO.getByName(
    DurableObjectNameCodec.stringify({
      projectId,
      path: source.repoPath,
    }),
  ).getWorkerSource({ path: source.sourcePath });

  return {
    ...resolved,
    cacheKey: hashString(
      JSON.stringify({
        repoPath: source.repoPath,
        repoSourceCacheKey: resolved.cacheKey,
        sourcePath: source.sourcePath,
      }),
    ),
  };
}

export function loadResolvedWorker({
  bindings,
  loader,
  projectId,
  ref,
  resolved,
  workerScopeKey,
}: {
  bindings: WorkerBindings;
  loader: WorkerLoader;
  projectId: string;
  ref: WorkerRef;
  resolved: ResolvedWorkerSource;
  workerScopeKey: string;
}): WorkerStub {
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
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  }));
}
