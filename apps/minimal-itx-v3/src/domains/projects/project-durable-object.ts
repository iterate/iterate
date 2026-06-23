import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN, trustedInternalAuthContext } from "../../auth.ts";
import type { Project, ProjectWorker, StreamEvent } from "../../../types-and-schemas.ts";
import type { ItxProcessorRpc } from "../../itx/processor.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor } from "../../itx/processor.ts";
import {
  AgentsTarget,
  ProjectWorkerTarget,
  ReposTarget,
  StreamsTarget,
} from "../../rpc_targets.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { parseDurableObjectName } from "../durable-object-names.ts";
import { ProjectProcessor, ProjectProcessorContract } from "./project-processor.ts";

const PROJECT_REPO_PATH = "/repos/project";

type InternalStreamWriter = {
  append(input: unknown): Promise<unknown>;
  appendEventSummary(input: unknown): Promise<Pick<StreamEvent, "createdAt" | "offset">>;
};

export class ProjectDurableObject extends DurableObject<Env> implements Project {
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

  #streamWriter(): InternalStreamWriter {
    return this.#stream as unknown as InternalStreamWriter;
  }

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
          iterateContext: { stream: this.#stream as never },
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

  get streams(): Project["streams"] {
    return new StreamsTarget({
      auth: trustedInternalAuthContext(),
      projectId: this.#name.projectId,
    }) as unknown as Project["streams"];
  }

  get agents(): Project["agents"] {
    return new AgentsTarget({
      auth: trustedInternalAuthContext(),
      projectId: this.#name.projectId,
    }) as unknown as Project["agents"];
  }

  get repos(): Project["repos"] {
    return new ReposTarget({
      auth: trustedInternalAuthContext(),
      projectId: this.#name.projectId,
    }) as unknown as Project["repos"];
  }

  get repo(): Project["repo"] {
    return this.repos.get(PROJECT_REPO_PATH);
  }

  get worker(): ProjectWorker {
    return new ProjectWorkerTarget({
      auth: trustedInternalAuthContext(),
      projectId: this.#name.projectId,
    }) as unknown as ProjectWorker;
  }

  async workerFetch(req: Request) {
    const worker = await this.#dynamicWorkers.get<ProjectWorker>({
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: "worker.js",
        type: "repo",
      },
      target: { type: "worker-entrypoint" },
    });
    return await worker.fetch(req);
  }

  async workerProcessEvent(input: Parameters<ProjectWorker["processEvent"]>[0]) {
    const worker = await this.#dynamicWorkers.get<ProjectWorker>({
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: "worker.js",
        type: "repo",
      },
      target: { type: "worker-entrypoint" },
    });
    return await worker.processEvent(input);
  }

  async create(): Promise<StreamEvent> {
    const committed = await this.#streamWriter().appendEventSummary({
      event: {
        type: "events.iterate.com/project/created",
        idempotencyKey: `project-created:${this.#name.projectId}`,
        payload: { projectId: this.#name.projectId },
      },
    });
    return {
      createdAt: committed.createdAt,
      idempotencyKey: `project-created:${this.#name.projectId}`,
      offset: committed.offset,
      payload: { projectId: this.#name.projectId },
      type: "events.iterate.com/project/created",
    };
  }

  async runScript(code: string) {
    return await this.#itxProcessor.runScript(code);
  }

  async provideCapability(input: Parameters<Project["provideCapability"]>[0]) {
    await this.#itxProcessor.provideCapability(input);
    return {
      revoke: () => {
        void this.revokeCapability({ path: input.path });
      },
    };
  }

  revokeCapability(input: Parameters<Project["revokeCapability"]>[0]) {
    return this.#itxProcessor.revokeCapability(input);
  }
}
