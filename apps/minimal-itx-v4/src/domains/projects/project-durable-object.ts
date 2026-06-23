import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN, trustedInternalAuthContext } from "../../auth.ts";
import { ItxProcessor, type ItxProcessorRpc } from "../../itx/processor.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { Project, ProjectWorker, RpcTargetImplementation } from "../../../types.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "../repos/project-repo.ts";
import { ProjectRpcTarget } from "../../rpc-targets.ts";
import { ProjectProcessor, ProjectProcessorContract } from "./project-processor.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parseProjectScoped(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
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

    this.#itxProcessor = this.#processorHost.add(
      ItxContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkers: this.#dynamicWorkers,
          host: { projectId: this.#name.projectId },
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
      ctx: this.ctx,
      projectId: this.#name.projectId,
    });
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
    return this.#dynamicWorkers.get<ProjectWorker>({
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: PROJECT_WORKER_SOURCE_PATH,
        type: "repo",
      },
      target: {
        props: {
          auth: {
            type: "trusted-internal",
            token: TRUSTED_INTERNAL_ITX_TOKEN,
          },
          projectId: this.#name.projectId,
        },
        type: "worker-entrypoint",
      },
    });
  }

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
