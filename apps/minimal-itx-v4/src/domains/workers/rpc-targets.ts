import { RpcTarget } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { normalizePath } from "../durable-object-names.ts";
import { itxEntrypointProps, itxEntrypointScopeCacheKey } from "../itx/entrypoint-props.ts";
import { withInvokeCapabilityFallback } from "../itx/path-proxy.ts";
import { projectEgressFetcher } from "../projects/egress.ts";
import type { CfExecutionContext, ItxAuth } from "../itx/types.ts";
import { WorkerRef as WorkerRefSchema } from "./schemas.ts";
import type { WorkerCapability, WorkerCollection, WorkerRef } from "./types.ts";
import { WorkerRunner } from "./worker-runner.ts";

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

  get<T extends object = Record<string, unknown>>(ref: WorkerRef): WorkerCapability<T> {
    const parsed = WorkerRefSchema.parse(ref);
    return new WorkerRpcTarget({
      ctx: this.props.ctx,
      loader: this.props.loader,
      projectId: this.props.projectId,
      ref: parsed,
    }) as unknown as WorkerCapability<T>;
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

  constructor(props: {
    ctx: CfExecutionContext;
    loader: Env["LOADER"];
    projectId: string;
    ref: WorkerRef;
  }) {
    super();
    this.#ref = props.ref;
    const itxScope = itxEntrypointProps({
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
      globalOutbound: projectEgressFetcher(props.ctx.exports, props.projectId),
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
    // Keep every dynamic worker invocation behind WorkerRunner. Stateless
    // entrypoints, stateful DO facets, provided worker capabilities, and
    // project.worker all then share the same loader/egress/ITX binding rules.
    return await this.#runner.invokeCapability({
      args,
      path,
      ref: this.#ref,
    });
  }
}
