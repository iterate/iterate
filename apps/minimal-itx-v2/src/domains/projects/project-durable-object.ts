import { DurableObject, env, RpcTarget } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import type { ItxProcessorRpc, ProjectRpc } from "../../itx-types.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor } from "../../itx/processor.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { formatDurableObjectName, parseDurableObjectName } from "../durable-object-names.ts";
import { RepoRpcTarget } from "../repos/repo-durable-object.ts";
import { ProjectProcessor, ProjectProcessorContract } from "./project-processor.ts";

const PROJECT_REPO_PATH = "/repos/project";

export class ProjectDurableObject extends DurableObject<Env> implements ProjectRpc {
  readonly #name = parseDurableObjectName(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({ props: this.#name }),
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

  repo() {
    return new RepoRpcTarget({ path: PROJECT_REPO_PATH, projectId: this.#name.projectId });
  }
}

export class ProjectRpcTarget extends RpcTarget implements ProjectRpc {
  constructor(readonly props: { path: string; projectId: string }) {
    super();
  }

  egress(url: string, init?: RequestInit) {
    return this.#stub().egress(url, init);
  }

  repo() {
    return new RepoRpcTarget({ path: PROJECT_REPO_PATH, projectId: this.props.projectId });
  }

  #stub() {
    return env.PROJECT.getByName(formatDurableObjectName(this.props));
  }
}
