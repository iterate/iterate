import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN, trustedInternalAuthContext } from "../../auth.ts";
import type { ItxProcessorRpc } from "../../itx/processor.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor } from "../../itx/processor.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { Project, RpcTargetImplementation } from "../../../types.ts";
import { ProjectRpcTarget } from "../../rpc-targets.ts";
import { ProjectProcessor, ProjectProcessorContract } from "./project-processor.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parseProjectScoped(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #projectProcessor = this.#processorHost.add(
    ProjectProcessorContract.slug,
    (deps) =>
      new ProjectProcessor({
        ...deps,
        env: this.env,
        projectId: this.#name.projectId,
      }),
  );

  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({
        props: {
          type: "trusted-internal",
          token: TRUSTED_INTERNAL_ITX_TOKEN,
        },
      }),
    },
    facets: this.ctx.facets,
    loader: this.env.LOADER,
    projectId: this.#name.projectId,
    storage: this.ctx.storage,
  });

  readonly #itxProcessor: ItxProcessorRpc;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.#itxProcessor = this.#processorHost.add(
      ItxContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkers: this.#dynamicWorkers,
          stream: this.#stream as never,
        }),
    );
  }

  get itxProcessor(): ItxProcessorRpc {
    return this.#itxProcessor;
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#processorHost.requestStreamSubscription(args);
  }

  getCapability(): RpcTargetImplementation<Project> {
    return new ProjectRpcTarget({
      auth: trustedInternalAuthContext(),
      projectId: this.#name.projectId,
    });
  }

  // get rpcTarget() {
  //   return new ProjectRpcTarget({
  //     auth: trustedInternalAuthContext(),
  //     projectId: this.#name.projectId,
  //   });
  // }

  // updateProjectRepo() {
  //   return this.rpcTarget.streams.get("/").append({
  //     event: {
  //       type: "events.iterate.com/stream/subscription-configured",
  //       payload: {
  //         subscriptionKey: `repo:${this.#name.projectId}:${PROJECT_REPO_PATH}:${crypto.randomUUID()}`,
  //       },
  //     },
  //   });
  // }

  // get worker(): ProjectWorker {
  //   return new ProjectWorkerTarget({
  //     auth: trustedInternalAuthContext(),
  //     projectId: this.#name.projectId,
  //   }) as unknown as ProjectWorker;
  // }

  // async workerFetch(req: Request) {
  //   const worker = await this.#dynamicWorkers.get<ProjectWorker>({
  //     source: {
  //       repoPath: PROJECT_REPO_PATH,
  //       sourcePath: "worker.js",
  //       type: "repo",
  //     },
  //     target: { type: "worker-entrypoint" },
  //   });
  //   return await worker.fetch(req);
  // }

  // async workerProcessEvent(input: Parameters<ProjectWorker["processEvent"]>[0]) {
  //   const worker = await this.#dynamicWorkers.get<ProjectWorker>({
  //     source: {
  //       repoPath: PROJECT_REPO_PATH,
  //       sourcePath: "worker.js",
  //       type: "repo",
  //     },
  //     target: { type: "worker-entrypoint" },
  //   });
  //   return await worker.processEvent(input);
  // }

  get rpcTarget(): RpcTargetImplementation<Project> {
    return this.getCapability();
  }

  describe() {
    return {
      projectId: this.#name.projectId,
      name: this.ctx.id.name!,
    };
  }

  async runScript(code: string) {
    return await this.#itxProcessor.runScript(code);
  }

  async provideCapability(input: Parameters<Project["provideCapability"]>[0]) {
    await this.#itxProcessor.provideCapability(input);
    return {
      revoke: () => {
        return this.revokeCapability({ path: input.path });
      },
    };
  }

  revokeCapability(input: Parameters<Project["revokeCapability"]>[0]) {
    return this.#itxProcessor.revokeCapability(input);
  }
}
