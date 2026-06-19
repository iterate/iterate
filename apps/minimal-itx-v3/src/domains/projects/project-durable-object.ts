import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN, trustedInternalAuthContext } from "../../auth.ts";
import type { ItxProcessorRpc, ProjectRpc, ProjectWorkerRpc } from "../../itx-types.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor } from "../../itx/processor.ts";
import { ProjectWorkerRpcTarget, RepoRpcTarget } from "../../itx/rpc-targets.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { parseDurableObjectName } from "../durable-object-names.ts";
import { ProjectProcessor, ProjectProcessorContract } from "./project-processor.ts";

const PROJECT_REPO_PATH = "/repos/project";

export class ProjectDurableObject extends DurableObject<Env> implements ProjectRpc {
  readonly #name = parseDurableObjectName(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({
        props: {
          ...this.#name,
          auth: { type: "trusted-internal", token: TRUSTED_INTERNAL_ITX_TOKEN },
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
          env: this.env,
          projectId: this.#name.projectId,
        }),
    );
    this.#itxProcessor = this.#processorHost.add(
      ItxContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkers: this.#dynamicWorkers,
          iterateContext: { stream: this.#stream },
        }),
    );
  }

  get itxProcessor(): ItxProcessorRpc {
    return this.#itxProcessor;
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#processorHost.requestStreamSubscription(args);
  }

  egress(url: string, init?: RequestInit) {
    return fetch(url, init);
  }

  get worker(): ProjectWorkerRpc {
    return new ProjectWorkerRpcTarget({
      auth: trustedInternalAuthContext(),
      projectId: this.#name.projectId,
    });
  }

  async workerAdd(a: number, b: number) {
    const worker = await this.#dynamicWorkers.get<ProjectWorkerRpc>({
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: "worker.js",
        type: "from-repo",
      },
      type: "worker-entrypoint",
    });
    return await worker.add(a, b);
  }

  async workerGreet(name?: string) {
    const worker = await this.#dynamicWorkers.get<ProjectWorkerRpc>({
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: "worker.js",
        type: "from-repo",
      },
      type: "worker-entrypoint",
    });
    return await worker.greet(name);
  }

  repo() {
    return new RepoRpcTarget({
      auth: trustedInternalAuthContext(),
      path: PROJECT_REPO_PATH,
      projectId: this.#name.projectId,
    });
  }
}
