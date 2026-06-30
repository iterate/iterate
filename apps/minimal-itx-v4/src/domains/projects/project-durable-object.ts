import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import type { ProjectWorker } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { itxEntrypointProps, itxEntrypointScopeCacheKey } from "../itx/entrypoint-props.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "../repos/project-repo.ts";
import { WorkerRunner } from "../workers/worker-runner.ts";
import { projectEgressFetcher } from "./egress.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #itxScope = itxEntrypointProps({
    path: this.#name.path,
    projectId: this.#name.projectId,
  });

  readonly #workerRunner = new WorkerRunner({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({
        props: this.#itxScope,
      }),
    },
    globalOutbound: projectEgressFetcher(this.ctx.exports, this.#name.projectId),
    loader: this.env.LOADER,
    projectId: this.#name.projectId,
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
    return this.#workerRunner.getStatelessEntrypoint<ProjectWorker>({
      path: "/",
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: PROJECT_WORKER_SOURCE_PATH,
        type: "repo",
      },
      type: "stateless",
    });
  }

  describe() {
    return {
      projectId: this.#name.projectId,
      name: this.ctx.id.name!,
    };
  }
}
