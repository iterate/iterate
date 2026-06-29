import { env } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { invokeFlattenedPath, replayPath } from "../itx/live-capability.ts";
import { loadResolvedWorker, resolveWorkerSource, type WorkerBindings } from "./worker-loader.ts";
import type { StatefulWorkerRef, StatelessWorkerRef, WorkerRef } from "./types.ts";

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
  readonly #loader: Env["LOADER"];
  readonly #projectId: string;
  readonly #workerScopeKey: string;

  constructor(props: {
    bindings: WorkerBindings;
    loader: Env["LOADER"];
    projectId: string;
    workerScopeKey: string;
  }) {
    this.#bindings = props.bindings;
    this.#loader = props.loader;
    this.#projectId = props.projectId;
    this.#workerScopeKey = props.workerScopeKey;
  }

  async get<T = unknown>(ref: StatelessWorkerRef): Promise<T> {
    return (await this.#getStateless(ref)) as T;
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

    const target = await this.#getStateless(ref);
    return flattenNestedPath
      ? await invokeFlattenedPath({ args, path, target })
      : await replayPath({ args, path, target });
  }

  async #getStateless(ref: StatelessWorkerRef): Promise<unknown> {
    const resolved = await resolveWorkerSource({
      projectId: this.#projectId,
      source: ref.source,
    });
    const worker = loadResolvedWorker({
      bindings: this.#bindings,
      loader: this.#loader,
      projectId: this.#projectId,
      ref,
      resolved,
      workerScopeKey: this.#workerScopeKey,
    });
    return worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} });
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
export function statefulWorkerDurableObjectName(projectId: string, ref: StatefulWorkerRef): string {
  return DurableObjectNameCodec.stringify({
    projectId,
    path: ref.path,
    props: {
      durableWorkerKey: ref.durableWorkerKey,
    },
  });
}
