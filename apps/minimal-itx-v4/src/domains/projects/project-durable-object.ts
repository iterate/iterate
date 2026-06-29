import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN, trustedInternalAuthContext } from "../../auth.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";
import { ItxProcessor, type ItxProcessorRpc } from "../itx/itx-processor-implementation.ts";
import { DynamicWorkerRuntimeRpcTarget } from "../dynamic-workers/rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "../repos/project-repo.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";
import { ProjectRpcTarget } from "./rpc-targets.ts";
import type { Project, ProjectWorker } from "./types.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parseProjectScoped(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkerRuntime = new DynamicWorkerRuntimeRpcTarget({
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
      ItxProcessorContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkerRuntime: this.#dynamicWorkerRuntime,
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

  getCapability() {
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
    return this.#dynamicWorkerRuntime.get<ProjectWorker>({
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

  get rpcTarget() {
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
