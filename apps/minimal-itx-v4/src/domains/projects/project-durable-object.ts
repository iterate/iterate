import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { DynamicWorkerRuntimeRpcTarget } from "../dynamic-workers/rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { itxEntrypointScopeCacheKey, scopedItxEntrypointProps } from "../itx/entrypoint-props.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "../repos/project-repo.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";
import type { ProjectWorker } from "./types.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #itxScope = scopedItxEntrypointProps({
    path: this.#name.path,
    projectId: this.#name.projectId,
  });

  readonly #dynamicWorkerRuntime = new DynamicWorkerRuntimeRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({
        props: this.#itxScope,
      }),
    },
    facets: this.ctx.facets,
    loader: this.env.LOADER,
    projectId: this.#name.projectId,
    storage: this.ctx.storage,
    workerScopeKey: itxEntrypointScopeCacheKey(this.#itxScope),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.#processorHost.add(
      ProjectProcessorContract.slug,
      (deps) =>
        new ProjectProcessor({
          ...deps,
          ensureDefaultWorkerLoaded: () => this.ensureDefaultWorkerLoaded(),
          forwardEventToProjectWorker: (event) => this.forwardEventToProjectWorker(event),
          projectId: this.#name.projectId,
        }),
    );
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#processorHost.requestStreamSubscription(args);
  }

  async ensureDefaultWorkerLoaded(): Promise<void> {
    const worker = await this.defaultProjectWorker();
    if (typeof worker.fetch !== "function") {
      throw new Error("Default project worker does not expose fetch().");
    }
  }

  async forwardEventToProjectWorker(event: Parameters<ProjectWorker["processEvent"]>[0]["event"]) {
    await (await this.defaultProjectWorker()).processEvent({ event });
  }

  private defaultProjectWorker() {
    return this.#dynamicWorkerRuntime.get<ProjectWorker>({
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: PROJECT_WORKER_SOURCE_PATH,
        type: "repo",
      },
      target: {
        type: "worker-entrypoint",
      },
    });
  }

  describe() {
    return {
      projectId: this.#name.projectId,
      name: this.ctx.id.name!,
    };
  }
}
