import { env, RpcTarget } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { normalizePath } from "../durable-object-names.ts";
import { itxEntrypointScopeCacheKey, scopedItxEntrypointProps } from "../itx/entrypoint-props.ts";
import { replayPath } from "../itx/live-capability.ts";
import { withInvokeCapabilityFallback } from "../itx/path-proxy.ts";
import type { CfExecutionContext, ItxAuth } from "../itx/types.ts";
import { WorkerRef as WorkerRefSchema } from "./schemas.ts";
import type { WorkerCollection, WorkerRef } from "./types.ts";
import { WorkerRunner, statefulWorkerDurableObjectName } from "./worker-runner.ts";

type StatefulWorkerRpc = {
  invokeCapability(input: {
    args?: unknown[];
    path: string[];
    ref: Extract<WorkerRef, { type: "stateful" }>;
  }): Promise<unknown>;
};

/**
 * Public project-facing worker collection.
 *
 * `get(ref)` mirrors the desired capability-tree shape:
 * `itx.projects.get("prj").workers.get(ref).someRpcMethod()`.
 */
export class WorkerCollectionRpcTarget extends RpcTarget implements WorkerCollection {
  constructor(
    readonly props: {
      auth: ItxAuth;
      ctx: CfExecutionContext;
      loader: Env["LOADER"];
      projectId: string;
    },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get<T = unknown>(ref: WorkerRef): T {
    const parsed = WorkerRefSchema.parse(ref);
    return new WorkerRpcTarget({
      ctx: this.props.ctx,
      loader: this.props.loader,
      projectId: this.props.projectId,
      ref: parsed,
    }) as T;
  }
}

/**
 * RPC wrapper around a single WorkerRef.
 *
 * The returned object is a path proxy: unknown properties become path segments
 * and eventually call `invokeCapability`. Explicit `fetch` and `processEvent`
 * methods keep common WorkerEntrypoint methods discoverable and typed.
 */
class WorkerRpcTarget extends RpcTarget {
  readonly #runner: WorkerRunner;
  readonly #ref: WorkerRef;
  readonly #projectId: string;

  constructor(props: {
    ctx: CfExecutionContext;
    loader: Env["LOADER"];
    projectId: string;
    ref: WorkerRef;
  }) {
    super();
    this.#ref = props.ref;
    this.#projectId = props.projectId;
    const itxScope = scopedItxEntrypointProps({
      path: normalizePath(props.ref.path),
      projectId: props.projectId,
    });
    this.#runner = new WorkerRunner({
      bindings: {
        // The dynamic worker's ITX binding is supplied by the host context, not
        // by the worker ref. Props remain worker-supplied, but auth/scope stay
        // under the project/agent/ITX object that is doing the hosting.
        ITX: props.ctx.exports.ItxEntrypoint({ props: itxScope }),
      },
      loader: props.loader,
      projectId: props.projectId,
      workerScopeKey: itxEntrypointScopeCacheKey(itxScope),
    });
    return withInvokeCapabilityFallback(this);
  }

  async fetch(req: Request): Promise<Response> {
    return (await this.invokeCapability({ args: [req], path: ["fetch"] })) as Response;
  }

  async processEvent(input: unknown): Promise<unknown> {
    return await this.invokeCapability({ args: [input], path: ["processEvent"] });
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    const ref = this.#ref;
    if (ref.type === "stateful") {
      return await this.#statefulWorker().invokeCapability({
        args,
        path,
        ref,
      });
    }

    return await replayPath({
      args,
      path,
      target: await this.#runner.get(ref),
    });
  }

  #statefulWorker(): StatefulWorkerRpc {
    if (this.#ref.type !== "stateful") {
      throw new Error("Expected a stateful worker ref.");
    }
    return env.WORKER.getByName(
      statefulWorkerDurableObjectName(this.#projectId, this.#ref),
    ) as unknown as StatefulWorkerRpc;
  }
}
