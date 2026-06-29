import { env, RpcTarget } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { AgentCollectionRpcTarget } from "../agents/rpc-targets.ts";
import { RepoCollectionRpcTarget, RepoRpcTarget } from "../repos/rpc-targets.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "../repos/project-repo.ts";
import { StreamCollectionRpcTarget, StreamRpcTarget } from "../streams/rpc-targets.ts";
import { subscriptionConfiguredEvent } from "../streams/subscription-event.ts";
import { rejectBuiltinCollision, withInvokeCapabilityFallback } from "../itx/path-proxy.ts";
import { type ProvideCapabilityInput } from "../itx/itx-processor-implementation.ts";
import type { CfExecutionContext, ItxAuth } from "../itx/types.ts";
import { WorkerCollectionRpcTarget } from "../workers/rpc-targets.ts";
import type { WorkerRef } from "../workers/types.ts";
import type { Project, ProjectCollection, ProjectWorker } from "./types.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

function projectRootStream(props: { auth: ItxAuth; projectId: string }) {
  return new StreamRpcTarget({
    auth: props.auth,
    projectId: props.projectId,
    path: "/",
  });
}

export class ProjectCollectionRpcTarget extends RpcTarget implements ProjectCollection {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext }) {
    super();
  }

  get(projectId: string) {
    return new ProjectRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: projectId,
    });
  }

  async create(args: Parameters<ProjectCollection["create"]>[0]) {
    if (!this.props.auth.isAdmin()) {
      throw new Error(`principal "${this.props.auth.principal}" cannot create projects`);
    }

    if (args.projectId === undefined) {
      args.projectId = "prj_" + crypto.randomUUID();
    }

    const stream = projectRootStream({
      auth: this.props.auth,
      projectId: args.projectId,
    });

    const [, , createRequested] = await stream.append(
      subscriptionConfiguredEvent({
        projectId: args.projectId,
        path: "/",
        bindingName: "PROJECT",
        processorName: ProjectProcessorContract.slug,
      }),
      subscriptionConfiguredEvent({
        projectId: args.projectId,
        path: PROJECT_REPO_PATH,
        bindingName: "REPO",
        processorName: RepoProcessorContract.slug,
      }),
      {
        type: "events.iterate.com/project/create-requested",
        idempotencyKey: `project-create-requested:${args.projectId}`,
        payload: { projectId: args.projectId, slug: args.slug },
      },
    );
    await stream.waitForEvent({
      afterOffset: createRequested.offset - 1,
      eventTypes: ["events.iterate.com/project/created"],
      predicate: (event) => event.payload?.projectId === args.projectId,
      timeoutMs: 60_000,
    });

    return new ProjectRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: args.projectId,
    });
  }

  list(): string[] {
    return this.props.auth.listAccessibleProjects();
  }
}

class ProjectRpcTarget extends RpcTarget implements Project {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  get durableObjectStub() {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  describe() {
    return this.durableObjectStub.describe();
  }

  #itx() {
    return env.ITX.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  async provideCapability(input: ProvideCapabilityInput) {
    rejectBuiltinCollision(this, input.path);
    await this.#itx().provideCapability(input);
    return {
      revoke: async () => {
        await this.#itx().revokeCapability({ path: input.path });
      },
    };
  }

  async revokeCapability(input: { path: string[] }) {
    await this.#itx().revokeCapability(input);
  }

  async runScript(code: string) {
    return await this.#itx().runScript(code);
  }

  invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    return this.#itx().invokeCapability({ args, path });
  }

  get streams() {
    return new StreamCollectionRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get agents() {
    return new AgentCollectionRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: this.props.projectId,
    });
  }

  get repos() {
    return new RepoCollectionRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get repo() {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: PROJECT_REPO_PATH,
      projectId: this.props.projectId,
    });
  }

  get workers() {
    return new WorkerCollectionRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      loader: env.LOADER,
      projectId: this.props.projectId,
    });
  }

  get worker() {
    return this.workers.get<ProjectWorker>(defaultProjectWorkerRef());
  }
}

function defaultProjectWorkerRef(): WorkerRef {
  return {
    path: "/",
    source: {
      repoPath: PROJECT_REPO_PATH,
      sourcePath: PROJECT_WORKER_SOURCE_PATH,
      type: "repo",
    },
    type: "stateless",
  };
}
