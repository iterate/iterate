import { tracing } from "cloudflare:workers";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { itxEnv as env } from "../../env.ts";
import { itxEntrypointBinding, itxEntrypointProps } from "../itx/utils.ts";
import type { ItxSurface } from "../itx/surface.ts";
import type { StreamContext } from "../projects/stream-context.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { isDurableObjectLifecycleError } from "../streams/stream-unavailable.ts";
import { invokePreferringFlattenedPath, replayPath } from "../capability-host/live-capability.ts";
import { WorkerBuildFailedError, type WorkerBuildFailure } from "./artifact-store.ts";
import type {
  StatefulDynamicWorkerRef,
  StatelessDynamicWorkerRef,
  DynamicWorkerRef,
} from "./schemas.ts";
import {
  isWebSocketUpgradeRequest,
  withWorkerFetchDispatchHeader,
} from "./worker-fetch-dispatch.ts";
import { withWorkerCommit } from "./worker-serve-info.ts";
import {
  loadResolvedWorker,
  resolveWorkerSource,
  type ResolvedWorkerSource,
  type ResolvedWorkerSourceResult,
  type WorkerBindings,
} from "./worker-loader.ts";

export type DynamicWorkerTraceRole = "project_config" | "run_script" | "scheduler_action";

const WORKERS_RPC_CLONE_VERSION_ERROR =
  "Unable to deserialize cloned data due to invalid or unsupported version.";

/** True when an error is workerd's clone-version skew — a loader isolate
 * outliving the bindings it captured. The one error class where retiring the
 * shared isolate (a recovery nonce) and retrying is the correct response. */
export function isWorkerRpcCloneVersionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(WORKERS_RPC_CLONE_VERSION_ERROR);
}

// Recovery nonce for the shared-scope lanes in this parent isolate. Undefined
// in steady state ON PURPOSE: shared-scope loads then ride the bare loader
// identity, so parent isolates coming and going mint NO new billable Dynamic
// Workers (a per-runner nonce turned every project-host request and every
// stream delivery into a new identity and a cold isolate — 2026-08: ~3.9M
// identities ≈ $7.8k). Set only when a clone-version skew proves the cached
// isolate stale; every shared-scope load in this parent isolate then abandons
// it for the replacement.
let sharedLoaderRecoveryNonce: string | undefined;

// Structural shadow of StatefulWorkerDurableObject.invokeCapability instead
// of the DO's own type: the DO imports this module (cycle), and a typed
// DurableObjectStub of it deep-instantiates the stub's self-referential type
// (TS2589) — same workaround as ParentItxScope in itx-durable-object.ts.
type StatefulWorkerRpc = {
  invokeCapability(input: {
    args?: unknown[];
    buildFailureNonce: string;
    buildBudgetMs?: number;
    flattenNestedPath?: boolean;
    path: string[];
    ref: StatefulDynamicWorkerRef;
  }): Promise<unknown>;
  kill(): Promise<void>;
  setAlarm(input: { atMs: number | null; ref: StatefulDynamicWorkerRef }): Promise<void>;
  getAlarm(): Promise<number | null>;
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
  #loaderInstanceNonce: string | undefined;
  readonly #loaderScope: "shared" | "runner";
  readonly #projectId: string;
  readonly #scopePath: string;
  readonly #streamContext: StreamContext;

  constructor(props: {
    streamContext: StreamContext;
    /** The hosting context's `ctx.exports` — loopback entrypoints are minted
     * from it, so the isolate's authority is the host's, never the ref's. */
    exports: ExecutionContext["exports"];
    /**
     * Which lifetime keys this runner's loaded isolates in the Worker Loader
     * cache. Every distinct key is a billable Dynamic Worker per day, so the
     * choice is a dollar cost, not bookkeeping. "shared" loads under the bare
     * content-and-scope identity — no nonce at all in steady state, so warm
     * isolates are reused across requests, deliveries, and parent isolates
     * alike; the request-scoped lanes (ingress, itx dispatch, stream
     * delivery) use it, because a per-runner key minted a new billable
     * identity and a cold isolate per request. A shared isolate can outlive
     * the lifetime that minted its captured loopback bindings; the
     * clone-version retry then moves this parent isolate's shared loads onto
     * a recovery nonce. "runner" (default) keys loads to this runner alone —
     * Durable Object hosts keep it so a fresh incarnation never reuses a
     * facet isolate holding the previous incarnation's bindings (that lane
     * has no clone-skew retry).
     */
    loaderScope?: "shared" | "runner";
    projectId: string;
    /** The itx scope the loaded code runs in (its `env.ITX` answers here). */
    scopePath: string;
    /** Restrict the isolate's itx to these built-in members (domains/itx/surface.ts). */
    surface?: ItxSurface;
  }) {
    const itxScope = itxEntrypointProps({
      streamContext: props.streamContext,
      path: props.scopePath,
      projectId: props.projectId,
      purpose: "userspace",
      ...(props.surface === undefined ? {} : { surface: props.surface }),
    });
    this.#bindings = { ITX: itxEntrypointBinding(props.exports, itxScope) };
    this.#globalOutbound = projectEgressFetcher(
      props.exports,
      props.projectId,
      props.streamContext,
    );
    this.#loaderScope = props.loaderScope ?? "runner";
    this.#projectId = props.projectId;
    this.#scopePath = props.scopePath;
    this.#streamContext = props.streamContext;
  }

  /**
   * Stateless refs resolve to WorkerEntrypoint instances and can be invoked in
   * this isolate. Kept separate from stateful class loading so each path
   * states whether it wants an invokable entrypoint or a Durable Object class
   * hosted behind StatefulWorkerDurableObject.
   */
  async #getStatelessEntrypoint<T = unknown>(
    ref: StatelessDynamicWorkerRef,
    mode: "cached" | "one-off",
    buildBudgetMs?: number,
    freshInstanceNonce?: string,
  ): Promise<
    { ok: true; target: T; worker: WorkerStub } | { failure: WorkerBuildFailure; ok: false }
  > {
    const loaded = await this.#load(ref, mode, buildBudgetMs, freshInstanceNonce);
    if (!loaded.ok) return loaded;
    return {
      ok: true,
      target: loaded.worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} }) as T,
      worker: loaded.worker,
    };
  }

  /**
   * Stateful refs resolve only to a class plus source identity. The outer
   * Durable Object owns storage/facet lifetime and is the only place that should
   * instantiate or restart the hosted class.
   */
  async loadStatefulClass<T extends DurableObjectClass = DurableObjectClass>(
    ref: StatefulDynamicWorkerRef,
    buildBudgetMs?: number,
    /** Supplied only by a caller that just classified a clone-version skew on
     * this class's isolate; retires the shared identity for the rebuild. */
    freshInstanceNonce?: string,
  ): Promise<
    | { klass: T; ok: true; resolved: ResolvedWorkerSource }
    | { failure: WorkerBuildFailure; ok: false }
  > {
    const loaded = await this.#load(ref, "cached", buildBudgetMs, freshInstanceNonce);
    if (!loaded.ok) return loaded;
    return {
      klass: this.#durableObjectClass<T>(ref, loaded.worker),
      ok: true,
      resolved: loaded.resolved,
    };
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
    traceRole,
  }: {
    /** Give up on a cold build after this long (see resolveWorkerSource). */
    buildBudgetMs?: number;
    ref: DynamicWorkerRef;
    request: Request;
    traceRole?: DynamicWorkerTraceRole;
  }): Promise<Response> {
    return this.#trace(ref, "fetch", traceRole, async (span) => {
      const dispatch = async (
        currentRequest: Request,
        freshInstanceNonce?: string,
      ): Promise<Response> => {
        let resolved: ResolvedWorkerSource | undefined;
        if (
          "createApp" in ref.source &&
          !isWebSocketUpgradeRequest(currentRequest) &&
          (currentRequest.method === "GET" || currentRequest.method === "HEAD")
        ) {
          const result = await resolveWorkerSource({
            buildBudgetMs,
            projectId: this.#projectId,
            source: ref.source,
          });
          if (!result.ok) throw new WorkerBuildFailedError(result.failure);
          resolved = result.source;
          const asset = await env.WORKER_BUNDLER.handleAssetRequest(
            currentRequest,
            resolved.assetManifest,
            resolved.assets,
            resolved.assetConfig,
          );
          if (asset !== null) {
            return withWorkerCommit(asset, resolved.commitOid);
          }
        }

        if (ref.type === "stateful") {
          // The hosting DO resolves the facet and stamps its trusted build
          // header after the user response returns.
          return await (
            env.WORKER.getByName(
              statefulWorkerDurableObjectName(this.#projectId, ref),
            ) as unknown as Fetcher
          ).fetch(withWorkerFetchDispatchHeader(currentRequest, { buildBudgetMs, ref }));
        }
        if (resolved === undefined) {
          const result = await resolveWorkerSource({
            buildBudgetMs,
            projectId: this.#projectId,
            source: ref.source,
          });
          if (!result.ok) throw new WorkerBuildFailedError(result.failure);
          resolved = result.source;
        }
        // The serve header is trusted platform output on the fetch lane —
        // stamped (and any user-set value dropped) at this authority boundary.
        const entrypoint = this.#loadResolved(resolved, "cached", freshInstanceNonce).getEntrypoint(
          ref.entrypoint,
          {
            props: ref.props ?? {},
          },
        ) as Fetcher;
        return withWorkerCommit(await entrypoint.fetch(currentRequest), resolved.commitOid);
      };

      const retryRequest =
        !isWebSocketUpgradeRequest(request) &&
        (request.method === "GET" || request.method === "HEAD")
          ? // Cloudflare's clone() widens the Request metadata generics even
            // though the runtime value remains the same Fetch API request.
            (request.clone() as typeof request)
          : undefined;
      let response: Response;
      try {
        response = await dispatch(request);
      } catch (error) {
        if (retryRequest && ref.type === "stateful" && isDurableObjectLifecycleError(error)) {
          span.setAttribute("iterate.worker.durable_object_availability_retry", true);
          console.info("Stateful worker fetch retrying after Durable Object unavailability", {
            error,
            projectId: this.#projectId,
            rayId: request.headers.get("cf-ray") ?? undefined,
            traceRole,
          });
          // GET/HEAD are safe to replay. A deploy, eviction, or temporary
          // platform fault may retire the hosting DO between dispatch and
          // response; the second lookup reaches a fresh incarnation, and a
          // second failure remains terminal.
          response = await dispatch(retryRequest);
        } else if (
          retryRequest &&
          ref.type === "stateless" &&
          error instanceof Error &&
          error.message.includes(WORKERS_RPC_CLONE_VERSION_ERROR)
        ) {
          span.setAttribute("iterate.worker.rpc_clone_version_retry", true);
          console.warn("Workers RPC clone-version skew; retrying stateless fetch once", {
            projectId: this.#projectId,
            rayId: request.headers.get("cf-ray") ?? undefined,
            traceRole,
          });
          response = await dispatch(retryRequest, crypto.randomUUID());
        } else {
          throw error;
        }
      }
      span.setAttribute("http.response.status_code", response.status);
      return response;
    });
  }

  async invokeCapability({
    args = [],
    buildBudgetMs,
    flattenNestedPath = false,
    path,
    ref,
    traceRole,
  }: {
    args?: unknown[];
    /** Give up on a cold build after this long (see resolveWorkerSource). */
    buildBudgetMs?: number;
    flattenNestedPath?: boolean;
    path: string[];
    ref: DynamicWorkerRef;
    traceRole?: DynamicWorkerTraceRole;
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

    return this.#trace(ref, "call", traceRole, async (span) => {
      if (ref.type === "stateful") {
        // Method replay must happen inside StatefulWorkerDurableObject. Returning
        // a dynamic facet stub through one DO and then invoking it from another RPC
        // target has produced opaque internal RPC failures; keeping the replay at
        // the owning DO boundary also keeps storage affinity explicit. Stateful
        // refs are also deliberately lazy: mounting a worker capability only
        // commits the ref to the stream, while this first real invocation is the
        // point where source loading, version-marker writes, and facet restarts are
        // allowed to mutate durable runtime state.
        // Successful values pass through untouched because they may contain
        // live RPC stubs whose ownership transfers to our caller. A nonce-tagged
        // array lets the host return the build-failure branch as plain data:
        // Array.isArray can distinguish it without probing an RPC stub property.
        const buildFailureNonce = crypto.randomUUID();
        const result = await this.#statefulWorker(ref).invokeCapability({
          args,
          buildFailureNonce,
          buildBudgetMs,
          flattenNestedPath,
          path,
          ref,
        });
        if (Array.isArray(result) && result[0] === buildFailureNonce) {
          // The worker never sees the random nonce, so only the hosting DO can
          // produce this tuple; successful customer arrays cannot collide.
          const failure = result[1] as WorkerBuildFailure;
          throw new WorkerBuildFailedError(failure);
        }
        return result;
      }

      const dispatch = async (freshInstanceNonce?: string) => {
        const mode = traceRole === "run_script" ? "one-off" : "cached";
        const loaded = await this.#getStatelessEntrypoint(
          ref,
          mode,
          buildBudgetMs,
          freshInstanceNonce,
        );
        if (!loaded.ok) throw new WorkerBuildFailedError(loaded.failure);
        try {
          return flattenNestedPath
            ? await invokePreferringFlattenedPath({ args, path, target: loaded.target })
            : await replayPath({ args, path, target: loaded.target });
        } finally {
          if (mode === "one-off") {
            // Worker Loader owns two native handles: the loaded Worker and
            // the entrypoint stub derived from it. Releasing only the stub
            // leaves every one-off script's Worker alive until GC, so a burst
            // can keep later fresh loads queued even after its calls settle.
            // Dispose inside-out, while this invocation still owns both.
            try {
              disposeIgnoredRpcResult(loaded.target);
            } finally {
              disposeIgnoredRpcResult(loaded.worker);
            }
          }
        }
      };
      try {
        return await dispatch();
      } catch (error) {
        if (
          path.length !== 1 ||
          path[0] !== "processEventBatch" ||
          !(error instanceof Error) ||
          !error.message.includes(WORKERS_RPC_CLONE_VERSION_ERROR)
        ) {
          throw error;
        }
        span.setAttribute("iterate.worker.rpc_clone_version_retry", true);
        console.warn("Workers RPC clone-version skew; retrying stateless event batch once", {
          projectId: this.#projectId,
          traceRole,
        });
        return await dispatch(crypto.randomUUID());
      }
    });
  }

  /** Abort a stateful dynamic worker's outer Durable Object and hosted facet. */
  async kill(ref: StatefulDynamicWorkerRef): Promise<void> {
    await this.#statefulWorker(ref).kill();
  }

  /** Arm (or with null, disarm) a stateful dynamic worker's durable alarm. */
  async setAlarm(ref: StatefulDynamicWorkerRef, atMs: number | null): Promise<void> {
    await this.#statefulWorker(ref).setAlarm({ atMs, ref });
  }

  /** The stateful dynamic worker's currently armed alarm time, if any. */
  async getAlarm(ref: StatefulDynamicWorkerRef): Promise<number | null> {
    return await this.#statefulWorker(ref).getAlarm();
  }

  async #load(
    ref: DynamicWorkerRef,
    mode: "cached" | "one-off",
    buildBudgetMs?: number,
    freshInstanceNonce?: string,
  ): Promise<
    | { ok: true; resolved: ResolvedWorkerSource; worker: WorkerStub }
    | { failure: WorkerBuildFailure; ok: false }
  > {
    const result: ResolvedWorkerSourceResult = await resolveWorkerSource({
      buildBudgetMs,
      projectId: this.#projectId,
      source: ref.source,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      resolved: result.source,
      worker: this.#loadResolved(result.source, mode, freshInstanceNonce),
    };
  }

  #loadResolved(
    resolved: ResolvedWorkerSource,
    mode: "cached" | "one-off",
    freshInstanceNonce?: string,
  ): WorkerStub {
    if (freshInstanceNonce !== undefined) {
      // A clone-skew replacement must retire the stale isolate for every load
      // that would have shared it, not just this runner's — going back to a
      // known-stale shared key re-fails every later call.
      if (this.#loaderScope === "shared") {
        sharedLoaderRecoveryNonce = freshInstanceNonce;
      } else {
        this.#loaderInstanceNonce = freshInstanceNonce;
      }
    }
    return loadResolvedWorker({
      bindings: this.#bindings,
      globalOutbound: this.#globalOutbound,
      // Shared scope: usually undefined — the bare identity IS the key.
      loaderInstanceNonce:
        this.#loaderScope === "shared"
          ? sharedLoaderRecoveryNonce
          : (this.#loaderInstanceNonce ??= crypto.randomUUID()),
      mode,
      projectId: this.#projectId,
      resolved,
      scopePath: this.#scopePath,
      streamContext: this.#streamContext,
    });
  }

  #statefulWorker(ref: StatefulDynamicWorkerRef): StatefulWorkerRpc {
    return env.WORKER.getByName(
      statefulWorkerDurableObjectName(this.#projectId, ref),
    ) as unknown as StatefulWorkerRpc;
  }

  #trace<T>(
    ref: DynamicWorkerRef,
    operation: "call" | "fetch",
    traceRole: DynamicWorkerTraceRole | undefined,
    callback: (span: {
      setAttribute(name: string, value: boolean | number | string): void;
    }) => Promise<T>,
  ): Promise<T> {
    const source =
      "createApp" in ref.source ? ref.source.createApp.files : ref.source.createWorker.files;
    const kind = traceRole ?? (ref.type === "stateful" ? "stateful" : source.type);
    return tracing.enterSpan(`dynamic_worker.${kind}.${operation}`, async (span) => {
      span.setAttribute("iterate.worker.kind", kind);
      span.setAttribute("iterate.worker.operation", operation);
      span.setAttribute("iterate.worker.source", source.type);
      span.setAttribute("iterate.worker.type", ref.type);
      return await callback(span);
    });
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
