import { env } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { StatefulWorkerRef, StatelessWorkerRef, WorkerRef } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { invokeFlattenedPath, replayPath } from "../itx/live-capability.ts";
import {
  loadResolvedWorker,
  resolveWorkerSource,
  type ResolvedWorkerSource,
  type WorkerBindings,
} from "./worker-loader.ts";

type StatefulWorkerRpc = {
  invokeCapability(input: {
    args?: unknown[];
    flattenNestedPath?: boolean;
    path: string[];
    ref: StatefulWorkerRef;
  }): Promise<unknown>;
};

/**
 * Small internal executor for WorkerRefs.
 *
 * This is intentionally not an RpcTarget. Public capability-tree access goes
 * through `WorkerRpcTarget`; ITX processors use this directly so mounted
 * capabilities, project workers, and run-script all share one execution path.
 */
export class WorkerRunner {
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
   * this isolate. Keeping this separate from stateful class loading makes each
   * caller state whether it wants an invokable entrypoint or a Durable Object
   * class hosted behind StatefulWorkerDurableObject.
   */
  async getStatelessEntrypoint<T = unknown>(ref: StatelessWorkerRef): Promise<T> {
    const { worker } = await this.#load(ref);
    return worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} }) as T;
  }

  /**
   * Stateful refs resolve only to a class plus source identity. The outer
   * Durable Object owns storage/facet lifetime and is the only place that should
   * instantiate or restart the hosted class.
   */
  async loadStatefulClass<T extends DurableObjectClass = DurableObjectClass>(
    ref: StatefulWorkerRef,
  ): Promise<{ klass: T; resolved: ResolvedWorkerSource }> {
    const { resolved, worker } = await this.#load(ref);
    const klass = worker.getDurableObjectClass?.(ref.className);
    if (!klass) {
      throw new Error(`Worker source did not export DurableObject ${ref.className}.`);
    }
    return { klass: klass as T, resolved };
  }

  async invokeCapability({
    args = [],
    flattenNestedPath = false,
    path,
    ref,
  }: {
    args?: unknown[];
    flattenNestedPath?: boolean;
    path: string[];
    ref: WorkerRef;
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
        flattenNestedPath,
        path,
        ref,
      });
    }

    const target = await this.getStatelessEntrypoint(ref);
    return flattenNestedPath
      ? await invokeFlattenedPath({ args, path, target })
      : await replayPath({ args, path, target });
  }

  async #load(ref: WorkerRef): Promise<{ resolved: ResolvedWorkerSource; worker: WorkerStub }> {
    const resolved = await resolveWorkerSource({
      projectId: this.#projectId,
      source: ref.source,
    });
    const worker = loadResolvedWorker({
      bindings: this.#bindings,
      globalOutbound: this.#globalOutbound,
      loader: this.#loader,
      projectId: this.#projectId,
      ref,
      resolved,
      workerScopeKey: this.#workerScopeKey,
    });
    return { resolved, worker };
  }

  #statefulWorker(ref: StatefulWorkerRef): StatefulWorkerRpc {
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
function statefulWorkerDurableObjectName(projectId: string, ref: StatefulWorkerRef): string {
  return DurableObjectNameCodec.stringify({
    projectId,
    path: ref.path,
    props: {
      durableWorkerKey: ref.durableWorkerKey,
    },
  });
}
