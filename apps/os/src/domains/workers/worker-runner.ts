import { itxEnv as env } from "../../env.ts";
import { itxEntrypointBinding, itxEntrypointProps } from "../itx/utils.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { invokePreferringFlattenedPath, replayPath } from "../capability-host/live-capability.ts";
import type {
  StatefulDynamicWorkerRef,
  StatelessDynamicWorkerRef,
  DynamicWorkerRef,
} from "./schemas.ts";
import {
  isWebSocketUpgradeRequest,
  withWorkerFetchDispatchHeader,
} from "./worker-fetch-dispatch.ts";
import {
  loadResolvedWorker,
  resolveCachedArtifact,
  resolveWorkerSource,
  type ResolvedWorkerSource,
  type WorkerBindings,
  type WorkerSourceResolution,
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
  kill(): Promise<void>;
};

/**
 * Small internal executor for DynamicWorkerRefs — the authority boundary
 * where a dynamic isolate gets its env: a scoped itx loopback binding
 * (capability-tree access as the hosting scope) and the project egress
 * fetcher as globalOutbound (all network the isolate does flows through it —
 * secret substitution, egress control). This is intentionally not an
 * RpcTarget.
 */
export class DynamicWorkerRunner {
  readonly #bindings: WorkerBindings;
  readonly #globalOutbound: Fetcher;
  readonly #projectId: string;
  readonly #scopePath: string;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  #sourceResolution: WorkerSourceResolution | undefined;

  constructor(props: {
    /** The hosting context's `ctx.exports` — loopback entrypoints are minted
     * from it, so the isolate's authority is the host's, never the ref's. */
    exports: ExecutionContext["exports"];
    projectId: string;
    /** The itx scope the loaded code runs in (its `env.ITX` answers here). */
    scopePath: string;
    /** The host's `ctx.waitUntil` — keeps budget-expired cold builds alive
     * past the request that gave up on them (see resolveWorkerSource). */
    waitUntil: (promise: Promise<unknown>) => void;
  }) {
    const itxScope = itxEntrypointProps({ path: props.scopePath, projectId: props.projectId });
    this.#bindings = { ITX: itxEntrypointBinding(props.exports, itxScope) };
    this.#globalOutbound = projectEgressFetcher(props.exports, props.projectId);
    this.#projectId = props.projectId;
    this.#scopePath = props.scopePath;
    this.#waitUntil = props.waitUntil;
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

  /**
   * Fetch-native dispatch into a dynamic worker.
   *
   * WebSocket upgrades cannot ride method replay: a 101 response carrying
   * `webSocket` fails to serialize across RPC method-call boundaries
   * (workerd DataCloneError). This lane keeps every hop a real `fetch()` —
   * stateless refs hit the loaded entrypoint's fetch handler directly, and
   * stateful refs ride the Durable Object stub's fetch into
   * StatefulWorkerDurableObject, which forwards to the facet's fetch. Both
   * channels tunnel upgrades natively.
   */
  async fetch({
    buildBudgetMs,
    ref,
    request,
  }: {
    /** Give up on a cold build after this long (see resolveWorkerSource). */
    buildBudgetMs?: number;
    ref: DynamicWorkerRef;
    request: Request;
  }): Promise<Response> {
    if (ref.type === "stateful") {
      const stub = env.WORKER.getByName(
        statefulWorkerDurableObjectName(this.#projectId, ref),
      ) as unknown as Fetcher;
      return await stub.fetch(withWorkerFetchDispatchHeader(request, { buildBudgetMs, ref }));
    }
    const entrypoint = await this.#getStatelessEntrypoint<Fetcher>(ref, buildBudgetMs);
    return await entrypoint.fetch(request);
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
    // Capability dispatch is method calls; no name is protocol-special here,
    // `fetch` included (see docs/dynamic-worker-dispatch.md). A WebSocket
    // upgrade needs the REAL fetch handler on a real workerd object reached
    // over fetch hops — its 101 response cannot serialize across the RPC hops
    // replay uses, and silently rerouting on the name `fetch` would make it
    // magic in the capability tree when the model is precisely that it is
    // not. Refuse loudly, with directions.
    const [firstArg] = args;
    if (firstArg instanceof Request && isWebSocketUpgradeRequest(firstArg)) {
      throw new Error(
        "WebSocket upgrades cannot ride capability dispatch: a 101 response's socket does not " +
          "serialize across RPC method calls. Use the fetch lane instead — project ingress " +
          "dispatches app hosts over it automatically, and worker code calls env.ITX.fetch " +
          "with the target ref in the x-iterate-worker-dispatch header.",
      );
    }

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

  /** Abort a stateful dynamic worker's outer Durable Object and hosted facet. */
  async kill(ref: StatefulDynamicWorkerRef): Promise<void> {
    await this.#statefulWorker(ref).kill();
  }

  async #load(
    ref: DynamicWorkerRef,
    buildBudgetMs?: number,
  ): Promise<{ resolved: ResolvedWorkerSource; worker: WorkerStub }> {
    const resolution = await resolveWorkerSource({
      buildBudgetMs,
      previous: this.#sourceResolution,
      projectId: this.#projectId,
      source: ref.source,
      waitUntil: this.#waitUntil,
    });
    this.#sourceResolution = resolution;
    const { resolved } = resolution;
    return { resolved, worker: this.#loadResolved(ref, resolved) };
  }

  #loadResolved(ref: DynamicWorkerRef, resolved: ResolvedWorkerSource): WorkerStub {
    return loadResolvedWorker({
      bindings: this.#bindings,
      globalOutbound: this.#globalOutbound,
      projectId: this.#projectId,
      ref,
      resolved,
      scopePath: this.#scopePath,
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
 * The path is the event stream / itx scope path. The worker-specific durable key
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
