import { tracing } from "cloudflare:workers";
import {
  itxEnv as env,
  workerDeploymentVersion,
  type WorkerDeploymentVersionFormat,
} from "../../env.ts";
import { itxEntrypointBinding, itxEntrypointProps } from "../itx/utils.ts";
import type { StreamContext } from "../projects/stream-context.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { invokePreferringFlattenedPath, replayPath } from "../capability-host/live-capability.ts";
import {
  acquireDurableObjectDeploymentTarget,
  describeDeploymentVersion,
} from "../durable-object-deployment-readiness.ts";
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

const STATEFUL_WORKER_READINESS_CACHE_LIMIT = 128;
const WORKERS_RPC_CLONE_VERSION_ERROR =
  "Unable to deserialize cloned data due to invalid or unsupported version.";

// Structural shadow of StatefulWorkerDurableObject.invokeCapability instead
// of the DO's own type: the DO imports this module (cycle), and a typed
// DurableObjectStub of it deep-instantiates the stub's self-referential type
// (TS2589) — same workaround as ParentItxScope in itx-durable-object.ts.
type StatefulWorkerRpc = {
  deploymentVersion(
    format: WorkerDeploymentVersionFormat,
  ): PromiseLike<{ id: string; timestamp?: string } | string>;
  fetch(request: Request): Promise<Response>;
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
  readonly #projectId: string;
  readonly #scopePath: string;
  readonly #streamContext: StreamContext;
  readonly #statefulWorkerReadiness = new Map<string, Promise<StatefulWorkerRpc>>();

  constructor(props: {
    streamContext: StreamContext;
    /** The hosting context's `ctx.exports` — loopback entrypoints are minted
     * from it, so the isolate's authority is the host's, never the ref's. */
    exports: ExecutionContext["exports"];
    projectId: string;
    /** The itx scope the loaded code runs in (its `env.ITX` answers here). */
    scopePath: string;
  }) {
    const itxScope = itxEntrypointProps({
      streamContext: props.streamContext,
      path: props.scopePath,
      projectId: props.projectId,
      purpose: "userspace",
    });
    this.#bindings = { ITX: itxEntrypointBinding(props.exports, itxScope) };
    this.#globalOutbound = projectEgressFetcher(
      props.exports,
      props.projectId,
      props.streamContext,
    );
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
    buildBudgetMs?: number,
    freshInstanceNonce?: string,
  ): Promise<{ ok: true; target: T } | { failure: WorkerBuildFailure; ok: false }> {
    const loaded = await this.#load(ref, buildBudgetMs, freshInstanceNonce);
    if (!loaded.ok) return loaded;
    return {
      ok: true,
      target: loaded.worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} }) as T,
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
  ): Promise<
    | { klass: T; ok: true; resolved: ResolvedWorkerSource }
    | { failure: WorkerBuildFailure; ok: false }
  > {
    const loaded = await this.#load(ref, buildBudgetMs);
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
          return await this.#withDeploymentReadyStatefulWorker(ref, (worker) =>
            worker.fetch(withWorkerFetchDispatchHeader(currentRequest, { buildBudgetMs, ref })),
          );
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
        const entrypoint = this.#loadResolved(resolved, freshInstanceNonce).getEntrypoint(
          ref.entrypoint,
          {
            props: ref.props ?? {},
          },
        ) as Fetcher;
        return withWorkerCommit(await entrypoint.fetch(currentRequest), resolved.commitOid);
      };

      const retryRequest =
        ref.type === "stateless" &&
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
        if (
          retryRequest === undefined ||
          !(error instanceof Error) ||
          !error.message.includes(WORKERS_RPC_CLONE_VERSION_ERROR)
        ) {
          throw error;
        }
        span.setAttribute("iterate.worker.rpc_clone_version_retry", true);
        console.warn("Workers RPC clone-version skew; retrying stateless fetch once", {
          projectId: this.#projectId,
          rayId: request.headers.get("cf-ray") ?? undefined,
          traceRole,
        });
        response = await dispatch(retryRequest, crypto.randomUUID());
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
        const result = await this.#withDeploymentReadyStatefulWorker(ref, (worker) =>
          worker.invokeCapability({
            args,
            buildFailureNonce,
            buildBudgetMs,
            flattenNestedPath,
            path,
            ref,
          }),
        );
        if (Array.isArray(result) && result[0] === buildFailureNonce) {
          // The worker never sees the random nonce, so only the hosting DO can
          // produce this tuple; successful customer arrays cannot collide.
          const failure = result[1] as WorkerBuildFailure;
          throw new WorkerBuildFailedError(failure);
        }
        return result;
      }

      const dispatch = async (freshInstanceNonce?: string) => {
        const loaded = await this.#getStatelessEntrypoint(ref, buildBudgetMs, freshInstanceNonce);
        if (!loaded.ok) throw new WorkerBuildFailedError(loaded.failure);
        return flattenNestedPath
          ? await invokePreferringFlattenedPath({ args, path, target: loaded.target })
          : await replayPath({ args, path, target: loaded.target });
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
    const name = statefulWorkerDurableObjectName(this.#projectId, ref);
    try {
      await this.#withDeploymentReadyStatefulWorker(ref, (worker) => worker.kill());
    } finally {
      this.#statefulWorkerReadiness.delete(name);
    }
  }

  /** Arm (or with null, disarm) a stateful dynamic worker's durable alarm. */
  async setAlarm(ref: StatefulDynamicWorkerRef, atMs: number | null): Promise<void> {
    await this.#withDeploymentReadyStatefulWorker(ref, (worker) => worker.setAlarm({ atMs, ref }));
  }

  /** The stateful dynamic worker's currently armed alarm time, if any. */
  async getAlarm(ref: StatefulDynamicWorkerRef): Promise<number | null> {
    return await this.#withDeploymentReadyStatefulWorker(ref, (worker) => worker.getAlarm());
  }

  async #load(
    ref: DynamicWorkerRef,
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
      worker: this.#loadResolved(result.source, freshInstanceNonce),
    };
  }

  #loadResolved(resolved: ResolvedWorkerSource, freshInstanceNonce?: string): WorkerStub {
    return loadResolvedWorker({
      bindings: this.#bindings,
      freshInstanceNonce,
      globalOutbound: this.#globalOutbound,
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

  async #deploymentReadyStatefulWorker(ref: StatefulDynamicWorkerRef): Promise<StatefulWorkerRpc> {
    const name = statefulWorkerDurableObjectName(this.#projectId, ref);
    const existing = this.#statefulWorkerReadiness.get(name);
    if (existing !== undefined) return await existing;

    const expectedVersion = workerDeploymentVersion(env);
    const readiness = acquireDurableObjectDeploymentTarget({
      expectedVersion,
      getTarget: () => this.#statefulWorker(ref),
      notReadyError: (detail, cause) => {
        const message =
          `Stateful dynamic worker at "${ref.path}" was not ready for deployment version ` +
          `${describeDeploymentVersion(expectedVersion)} before it accepted an operation: ` +
          `${detail}. The operation was not sent to the dynamic worker.`;
        return cause === undefined ? new Error(message) : new Error(message, { cause });
      },
    })
      .then(({ readiness: result, target }) => {
        if (result.probes > 1 || result.targetNewer) {
          console.info("stateful dynamic worker deployment version converged before operation", {
            durableWorkerKey: ref.durableWorkerKey,
            expectedDeploymentVersion: expectedVersion,
            lifecycleFailures: result.lifecycleFailures,
            mismatches: result.mismatches,
            observedDeploymentVersion: result.observedVersion,
            path: ref.path,
            platformFailures: result.platformFailures,
            probeTimeouts: result.probeTimeouts,
            probes: result.probes,
            projectId: this.#projectId,
            targetNewer: result.targetNewer,
            waitedMs: result.waitedMs,
          });
        }
        return target;
      })
      .catch((error: unknown) => {
        this.#statefulWorkerReadiness.delete(name);
        throw error;
      });
    if (this.#statefulWorkerReadiness.size >= STATEFUL_WORKER_READINESS_CACHE_LIMIT) {
      const oldest = this.#statefulWorkerReadiness.keys().next().value;
      if (oldest !== undefined) this.#statefulWorkerReadiness.delete(oldest);
    }
    this.#statefulWorkerReadiness.set(name, readiness);
    return await readiness;
  }

  async #withDeploymentReadyStatefulWorker<Result>(
    ref: StatefulDynamicWorkerRef,
    operation: (worker: StatefulWorkerRpc) => Promise<Result>,
  ): Promise<Result> {
    const name = statefulWorkerDurableObjectName(this.#projectId, ref);
    const worker = await this.#deploymentReadyStatefulWorker(ref);
    try {
      return await operation(worker);
    } catch (error) {
      // The operation remains terminal and is never replayed: arbitrary
      // dynamic-worker effects may have happened. Forget only the read-only
      // proof so a later independent call must establish a fresh boundary.
      this.#statefulWorkerReadiness.delete(name);
      throw error;
    }
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
