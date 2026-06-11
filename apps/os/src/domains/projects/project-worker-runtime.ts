// Loading the project's worker OUTSIDE the dial: HTTP ingress
// (project-ingress-entrypoint.ts) and root-stream event forwarding
// (project-durable-object.ts). Same source (PROJECT_WORKER_SOURCE), same
// per-commit build memo, same loader key as `itx.worker` dials — every load
// site shares warm isolates, and the Project DO no longer owns any build
// machinery: building is the generic repo → R2 memo, owned by no one.

import type { Event } from "@iterate-com/shared/streams/types";
import { sourceIsolateKey, type WorkerLoaderBinding } from "~/itx/dial.ts";
import { wireIsolateEnv, type IsolateLoopback } from "~/itx/isolate.ts";
import { projectContextAddress } from "~/itx/journal.ts";
import { PROJECT_WORKER_SOURCE } from "~/itx/platform-context.ts";
import { resolveWorkerSource, type SourceBuildEnv } from "~/itx/source-build.ts";

/** The shape the project worker's default export must satisfy. */
export type ProjectWorkerEntrypoint = {
  [key: string]: unknown;
  [Symbol.dispose]?(): void;
  fetch(request: Request): Response | Promise<Response>;
  /**
   * Optional hook: the worker as a stream processor. Receives every event
   * committed to the project's root stream, in order, checkpointed (dialed
   * by the project-config-worker processor).
   */
  processEvent?(input: { event: Event; streamPath: string }): unknown | Promise<unknown>;
};

// The shared loader-binding shape lives in ~/itx/dial.ts (WorkerLoaderBinding).
export type { WorkerLoaderBinding } from "~/itx/dial.ts";

/**
 * Resolve (build or memo-hit) and load the project's worker, returning its
 * default-export entrypoint.
 */
export async function loadProjectWorker(input: {
  env: SourceBuildEnv & { LOADER: WorkerLoaderBinding };
  /** The loading host's loopback exports (ctx.exports). */
  exports: unknown;
  projectId: string;
  /** 0 probes the repo head now — event forwarding wants exactness: an
   * event can be the direct consequence of a config push, and serving the
   * previous worker would consume the very trigger the new config exists
   * to handle. Ingress accepts the default probe window (latency first). */
  latestMaxAgeMs?: number;
}): Promise<ProjectWorkerEntrypoint> {
  const resolved = await resolveWorkerSource({
    env: input.env,
    latestMaxAgeMs: input.latestMaxAgeMs,
    projectId: input.projectId,
    source: PROJECT_WORKER_SOURCE,
  });
  const loopback: IsolateLoopback = (exportName, options) => {
    const factory = (input.exports as Record<string, unknown>)[exportName];
    if (typeof factory !== "function") {
      throw new Error(`Loopback export ${exportName} is not available.`);
    }
    return factory(options);
  };
  const worker = input.env.LOADER.get(
    sourceIsolateKey({
      cacheKey: resolved.cacheKey,
      name: "worker",
      origin: { id: input.projectId },
    }),
    () =>
      wireIsolateEnv({
        capabilityPath: "worker",
        code: resolved,
        contextAddress: projectContextAddress(input.projectId),
        contextId: input.projectId,
        loopback,
        projectId: input.projectId,
      }),
  );
  const entrypoint = worker.getEntrypoint();
  if (!isProjectWorkerEntrypoint(entrypoint)) {
    throw new Error("Project worker default export is missing fetch.");
  }
  return entrypoint;
}

export function isProjectWorkerEntrypoint(value: unknown): value is ProjectWorkerEntrypoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

/**
 * "There is no worker to load" — a NORMAL state (the repo or its worker.js
 * does not exist yet), as opposed to a transient build/git failure. Event
 * forwarding skips on the former and rethrows the latter so checkpointed
 * delivery retries.
 *
 * Classified by `error.name`: every throw site is ours and typed
 * (MissingProjectWorkerError in ~/itx/source-build.ts; RepoNotCreatedError /
 * RepoEmptyError in ~/domains/repos), and Workers RPC preserves the name
 * across the repo-DO hop.
 */
const MISSING_PROJECT_WORKER_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MissingProjectWorkerError",
  "RepoNotCreatedError",
  "RepoEmptyError",
]);

export function isMissingProjectWorkerError(error: unknown): boolean {
  return error instanceof Error && MISSING_PROJECT_WORKER_ERROR_NAMES.has(error.name);
}
