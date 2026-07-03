import { itxEnv as env } from "../../env.ts";
import type { Env } from "../../env.ts";
import type {
  StatefulDynamicWorkerRef,
  StatelessDynamicWorkerRef,
  DynamicWorkerRef,
} from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { invokePreferringFlattenedPath, replayPath } from "../capability-host/live-capability.ts";
import {
  loadResolvedWorker,
  resolveCachedArtifact,
  resolveWorkerSource,
  type ResolvedWorkerSource,
  type WorkerBindings,
} from "./worker-loader.ts";

// Structural shadow of StatefulWorkerDurableObject.invokeCapability instead
// of the DO's own type: the DO imports this module (cycle), and a typed
// DurableObjectStub of it deep-instantiates the stub's self-referential type
// (TS2589) — same workaround as ParentItxScope in itx-durable-object.ts.
type StatefulWorkerRpc = {
  invokeCapability(input: {
    args?: unknown[];
    buildBudgetMs?: number;
    flattenNestedPath?: boolean;
    path: string[];
    ref: StatefulDynamicWorkerRef;
  }): Promise<unknown>;
};

/**
 * Small internal executor for DynamicWorkerRefs.
 *
 * WORKER-WORKER-INTERNAL: only `DynamicWorkerEntrypoint` (stateless dispatch)
 * and `StatefulWorkerDurableObject` (stateful class hosting) may construct
 * this — both live in the worker worker, the sole owner of the LOADER binding.
 * Everything else reaches dynamic workers through the `DYNAMIC_WORKERS`
 * service binding. This is intentionally not an RpcTarget.
 */
export class DynamicWorkerRunner {
  readonly #bindings: WorkerBindings;
  readonly #globalOutbound: Fetcher;
  readonly #loader: Env["LOADER"];
  readonly #projectId: string;
  readonly #workerScopeKey: string;

  constructor(props: {
    bindings: WorkerBindings;
    globalOutbound: Fetcher;
    loader: Env["LOADER"];
    projectId: string;
    workerScopeKey: string;
  }) {
    this.#bindings = props.bindings;
    this.#globalOutbound = props.globalOutbound;
    this.#loader = props.loader;
    this.#projectId = props.projectId;
    this.#workerScopeKey = props.workerScopeKey;
  }

  /**
   * Stateless refs resolve to WorkerEntrypoint instances and can be invoked in
   * this isolate. Kept separate from stateful class loading so each path
   * states whether it wants an invokable entrypoint or a Durable Object class
   * hosted behind StatefulWorkerDurableObject.
   */
  async #getStatelessEntrypoint<T = unknown>(
    ref: StatelessDynamicWorkerRef,
    buildBudgetMs?: number,
  ): Promise<T> {
    const { worker } = await this.#load(ref, buildBudgetMs);
    return worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} }) as T;
  }

  /**
   * Stateful refs resolve only to a class plus source identity. The outer
   * Durable Object owns storage/facet lifetime and is the only place that should
   * instantiate or restart the hosted class.
   */
  async loadStatefulClass<T extends DurableObjectClass = DurableObjectClass>(
    ref: StatefulDynamicWorkerRef,
    buildBudgetMs?: number,
  ): Promise<{ klass: T; resolved: ResolvedWorkerSource }> {
    const { resolved, worker } = await this.#load(ref, buildBudgetMs);
    return { klass: this.#durableObjectClass<T>(ref, worker), resolved };
  }

  /**
   * A stateful class from a previously built artifact, by exact cache key —
   * never triggers a build (see resolveCachedArtifact). Null when the
   * artifact is gone.
   */
  async loadStatefulClassFromCacheKey<T extends DurableObjectClass = DurableObjectClass>(
    ref: StatefulDynamicWorkerRef,
    cacheKey: string,
  ): Promise<{ klass: T; resolved: ResolvedWorkerSource } | null> {
    const resolved = await resolveCachedArtifact(cacheKey);
    if (resolved === null) return null;
    const worker = this.#loadResolved(ref, resolved);
    return { klass: this.#durableObjectClass<T>(ref, worker), resolved };
  }

  #durableObjectClass<T extends DurableObjectClass>(
    ref: StatefulDynamicWorkerRef,
    worker: WorkerStub,
  ): T {
    const klass = worker.getDurableObjectClass?.(ref.className);
    if (!klass) {
      throw new Error(`Worker source did not export DurableObject ${ref.className}.`);
    }
    return klass as T;
  }

  async invokeCapability({
    args = [],
    buildBudgetMs,
    flattenNestedPath = false,
    path,
    ref,
  }: {
    args?: unknown[];
    /** Give up on a cold build after this long (see resolveWorkerSource). */
    buildBudgetMs?: number;
    flattenNestedPath?: boolean;
    path: string[];
    ref: DynamicWorkerRef;
  }): Promise<unknown> {
    if (ref.type === "stateful") {
      // Method replay must happen inside StatefulWorkerDurableObject. Returning
      // a dynamic facet stub through one DO and then invoking it from another RPC
      // target has produced opaque internal RPC failures; keeping the replay at
      // the owning DO boundary also keeps storage affinity explicit. Stateful
      // refs are also deliberately lazy: mounting a worker capability only
      // commits the recipe to the stream, while this first real invocation is the
      // point where source loading, version-marker writes, and facet restarts are
      // allowed to mutate durable runtime state.
      return await this.#statefulWorker(ref).invokeCapability({
        args,
        buildBudgetMs,
        flattenNestedPath,
        path,
        ref,
      });
    }

    const target = await this.#getStatelessEntrypoint(ref, buildBudgetMs);
    return flattenNestedPath
      ? await invokePreferringFlattenedPath({ args, path, target })
      : await replayPath({ args, path, target });
  }

  async #load(
    ref: DynamicWorkerRef,
    buildBudgetMs?: number,
  ): Promise<{ resolved: ResolvedWorkerSource; worker: WorkerStub }> {
    const resolved = await resolveWorkerSource({
      buildBudgetMs,
      projectId: this.#projectId,
      source: ref.source,
    });
    return { resolved, worker: this.#loadResolved(ref, resolved) };
  }

  #loadResolved(ref: DynamicWorkerRef, resolved: ResolvedWorkerSource): WorkerStub {
    return loadResolvedWorker({
      bindings: this.#bindings,
      globalOutbound: this.#globalOutbound,
      loader: this.#loader,
      projectId: this.#projectId,
      ref,
      resolved,
      workerScopeKey: this.#workerScopeKey,
    });
  }

  #statefulWorker(ref: StatefulDynamicWorkerRef): StatefulWorkerRpc {
    return env.WORKER.getByName(
      statefulWorkerDurableObjectName(this.#projectId, ref),
    ) as unknown as StatefulWorkerRpc;
  }
}

/**
 * Durable identity for a stateful worker.
 *
 * The path is the event stream / ITX scope path. The worker-specific durable key
 * is a query prop so a DO name remains fetchable at the stream path in the
 * future while still allowing multiple durable workers under that path.
 */
function statefulWorkerDurableObjectName(projectId: string, ref: StatefulDynamicWorkerRef): string {
  return DurableObjectNameCodec.stringify({
    projectId,
    path: ref.path,
    props: {
      durableWorkerKey: ref.durableWorkerKey,
    },
  });
}
