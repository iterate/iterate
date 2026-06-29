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

export class WorkerRpcTarget extends RpcTarget {
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
    if (this.#ref.type === "stateful") {
      return await this.#statefulWorker().invokeCapability({
        args,
        path,
        ref: this.#ref,
      });
    }

    return await replayPath({
      args,
      path,
      target: await this.#runner.get(this.#ref),
    });
  }

  async validate(): Promise<void> {
    await this.#runner.validate(this.#ref);
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
