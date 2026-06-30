export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Declarative source for a dynamic worker.
 *
 * `inline` is the simplest execution primitive: the caller already has module
 * text and asks the Worker Loader to run it. `repo` keeps source identity
 * separate from runtime identity; the repo resolves the current worker source
 * and contributes its own cache key, so future repo commits affect the next use.
 */
export type WorkerSource =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      sourcePath: string;
    };

type WorkerRefBase = {
  /**
   * ITX scope path for the worker's `env.ITX` binding and for stateful worker
   * Durable Object names. This is intentionally not the mounted capability path:
   * one worker can be mounted at `db`, `counter`, etc. while all events still
   * belong to the host stream path.
   */
  path: string;
  source: WorkerSource;
};

/**
 * Stateless workers are WorkerEntrypoint exports loaded directly from source.
 *
 * `props` are passed to `worker.getEntrypoint(name, { props })` and appear as
 * `this.ctx.props` inside the exported WorkerEntrypoint. They deliberately live
 * only on stateless refs: Durable Object facets are started with
 * `ctx.facets.get(name, () => ({ class, id? }))`, which does not accept
 * WorkerEntrypoint-style props.
 */
export type StatelessWorkerRef = WorkerRefBase & {
  type: "stateless";
  entrypoint?: string;
  props?: Record<string, JsonValue>;
};

/**
 * Stateful workers are Durable Object class exports hosted by
 * `StatefulWorkerDurableObject`.
 *
 * `durableWorkerKey` is the durable identity under `{ projectId, path }`. It is
 * not a source cache key: source changes deliberately affect the next use of the
 * same durable worker identity.
 */
export type StatefulWorkerRef = WorkerRefBase & {
  type: "stateful";
  className: string;
  durableWorkerKey: string;
};

export type WorkerRef = StatelessWorkerRef | StatefulWorkerRef;

export type WorkerCapability<T extends object = Record<string, unknown>> = T & Disposable;

/** Capability-tree entry point for ad-hoc project-scoped worker refs. */
export interface WorkerCollection {
  get<T extends object = Record<string, unknown>>(ref: WorkerRef): WorkerCapability<T>;
}
