import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { fallbackCall } from "capnweb";
import { durableObjectProcessorSubscriber } from "./domains/streams/engine/shared/callable-subscriber.ts";
import type { Env } from "./env.ts";
import {
  authContextForPrincipal,
  PRINCIPALS,
  TRUSTED_INTERNAL_ITX_TOKEN,
  type ItxAuthContext,
} from "./auth.ts";
import { formatDurableObjectName } from "./domains/durable-object-names.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor.ts";
import { ItxContract } from "./itx/processor-contract.ts";
import type { ItxProcessorRpc, ProvideCapabilityInput } from "./itx/processor.ts";
import type {
  Agent as AgentContract,
  AgentItx as AgentItxContract,
  Agents as AgentsContract,
  ItxConnectInput,
  Project as ProjectContract,
  ProjectWorker as ProjectWorkerContract,
  Projects as ProjectsContract,
  Repo as RepoContract,
  Repos as ReposContract,
  RootItx as RootItxContract,
  RpcTargetImplementation,
  Stream as StreamContract,
  StreamEventInput,
  StreamEvent,
  Streams as StreamsContract,
  UnauthenticatedItx as UnauthenticatedItxContract,
} from "../types-and-schemas.ts";

const PROJECT_REPO_PATH = "/repos/project";

type InternalStreamWriter = {
  getEvents(input: unknown): Promise<unknown>;
  append(input: unknown): Promise<unknown>;
  appendBatch(input: unknown): Promise<unknown>;
  appendEventSummary(input: unknown): Promise<Pick<StreamEvent, "createdAt" | "offset">>;
  appendInternal(input: unknown): Promise<void>;
};

type InternalRepoWriter = {
  create(): Promise<unknown>;
  ensureCreated(): Promise<void>;
  whoami(): Promise<unknown>;
};

type InternalAgentWriter = {
  create(): Promise<unknown>;
  sendMessage(message: string): Promise<unknown>;
  whoami(): Promise<unknown>;
  itxProcessor: ItxProcessorRpc;
};

type InternalProjectWriter = {
  create(): Promise<unknown>;
  itxProcessor: ItxProcessorRpc;
  workerFetch(req: Request): Promise<unknown>;
  workerProcessEvent(input: unknown): Promise<unknown>;
};

function internalStreams(itxEnv: Env) {
  return (
    itxEnv as unknown as {
      STREAM: { getByName(name: string): InternalStreamWriter };
    }
  ).STREAM;
}

function globalStreams() {
  return (
    env as unknown as {
      STREAM: { getByName(name: string): InternalStreamWriter };
    }
  ).STREAM;
}

function internalRepos(itxEnv: Env) {
  return (
    itxEnv as unknown as {
      REPO: { getByName(name: string): InternalRepoWriter };
    }
  ).REPO;
}

function globalRepos() {
  return (
    env as unknown as {
      REPO: { getByName(name: string): InternalRepoWriter };
    }
  ).REPO;
}

function globalAgents() {
  return (
    env as unknown as {
      AGENT: { getByName(name: string): InternalAgentWriter };
    }
  ).AGENT;
}

function globalProjects() {
  return (
    env as unknown as {
      PROJECT: { getByName(name: string): InternalProjectWriter };
    }
  ).PROJECT;
}

export type RequestAuthContext = {
  serverCookieToken?: string | null;
};

export class UnauthenticatedItx
  extends RpcTarget
  implements RpcTargetImplementation<UnauthenticatedItxContract>
{
  constructor(
    readonly itxEnv: Env,
    readonly requestAuth: RequestAuthContext = {},
  ) {
    super();
  }

  authenticate(input: ItxConnectInput = {}): RootItxContract | ProjectContract | AgentItxContract {
    let auth: ItxAuthContext | null = null;
    const credential = input.auth;

    if (credential?.type === "token") {
      const principal = PRINCIPALS[credential.token];
      if (principal) auth = authContextForPrincipal(principal);
    }

    if (credential?.type === "from-server-cookie") {
      const token = this.requestAuth.serverCookieToken ?? "";
      const principal = PRINCIPALS[token];
      if (principal) auth = authContextForPrincipal(principal);
    }

    if (
      credential?.type === "trusted-internal" &&
      credential.token === TRUSTED_INTERNAL_ITX_TOKEN
    ) {
      auth = authContextForPrincipal({ access: "all", name: "trusted-internal" });
    }

    if (!auth) throw new Error("missing or invalid auth");

    if (!input.projectId) {
      if (input.path) throw new Error("path requires projectId");
      return new RootItx({ auth, env: this.itxEnv }) as unknown as RootItxContract;
    }

    const path = input.path ?? "/";
    if (path === "/") {
      return new ProjectItx({
        auth,
        path: "/",
        projectId: input.projectId,
      }) as unknown as ProjectContract;
    }
    if (path.startsWith("/agents/")) {
      return new AgentItx({
        auth,
        path,
        projectId: input.projectId,
      }) as unknown as AgentItxContract;
    }
    throw new Error(`no ITX host for path "${path}"`);
  }
}

export class RootProjectsTarget
  extends RpcTarget
  implements RpcTargetImplementation<ProjectsContract>
{
  constructor(readonly props: { auth: ItxAuthContext; env: Env }) {
    super();
  }

  get(projectId: string): ProjectContract {
    this.props.auth.requireProjectAccess(projectId);
    return new ProjectItx({
      auth: this.props.auth,
      path: "/",
      projectId,
    }) as unknown as ProjectContract;
  }

  list() {
    return this.props.auth.listAccessibleProjects();
  }

  async create(projectId: string) {
    this.props.auth.requireCanCreateProject();
    const durableObjectName = formatDurableObjectName({ path: "/", projectId });
    const projectRepoName = formatDurableObjectName({ path: PROJECT_REPO_PATH, projectId });
    const rootStream = internalStreams(this.props.env).getByName(durableObjectName);
    await rootStream.appendInternal({
      events: [
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `project-subscription:${projectId}:project`,
          payload: {
            subscriptionKey: `project:${projectId}`,
            subscriber: durableObjectProcessorSubscriber({
              bindingName: "PROJECT",
              durableObjectName,
              processorName: ProjectProcessorContract.slug,
            }),
          },
        } as StreamEventInput,
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `project-subscription:${projectId}:itx`,
          payload: {
            subscriptionKey: `itx:${projectId}:/`,
            subscriber: durableObjectProcessorSubscriber({
              bindingName: "PROJECT",
              durableObjectName,
              processorName: ItxContract.slug,
            }),
          },
        } as StreamEventInput,
      ],
    });
    const committed = await rootStream.appendEventSummary({
      event: {
        type: "events.iterate.com/project/created",
        idempotencyKey: `project-created:${projectId}`,
        payload: { projectId },
      },
    });
    const event: StreamEvent = {
      createdAt: committed.createdAt,
      idempotencyKey: `project-created:${projectId}`,
      offset: committed.offset,
      payload: { projectId },
      type: "events.iterate.com/project/created",
    };

    await internalStreams(this.props.env)
      .getByName(projectRepoName)
      .appendInternal({
        events: [
          {
            type: "events.iterate.com/stream/subscription-configured",
            payload: {
              subscriptionKey: `repo:${projectId}:${PROJECT_REPO_PATH}:${crypto.randomUUID()}`,
              subscriber: durableObjectProcessorSubscriber({
                bindingName: "REPO",
                durableObjectName: projectRepoName,
                processorName: RepoProcessorContract.slug,
              }),
            },
          } as StreamEventInput,
        ],
      });
    await internalRepos(this.props.env).getByName(projectRepoName).ensureCreated();

    return event;
  }
}

export class RootItx extends RpcTarget implements RpcTargetImplementation<RootItxContract> {
  constructor(readonly props: { auth: ItxAuthContext; env: Env }) {
    super();
  }

  get projects(): ProjectsContract {
    return new RootProjectsTarget(this.props) as unknown as ProjectsContract;
  }
}

abstract class ProjectScopedRpcTarget extends RpcTarget {
  constructor(readonly props: { auth: ItxAuthContext; projectId: string }) {
    super();
    this.props.auth.requireProjectAccess(this.props.projectId);
  }

  get auth() {
    return this.props.auth;
  }

  get projectId() {
    return this.props.projectId;
  }

  protected name(path: string) {
    return formatDurableObjectName({ path, projectId: this.projectId });
  }
}

abstract class ItxCapabilityHostTarget extends ProjectScopedRpcTarget {
  protected abstract itxProcessor(): ItxProcessorRpc;

  async provideCapability(input: ProvideCapabilityInput) {
    this.#rejectBuiltinCollision(input.path);
    await this.itxProcessor().provideCapability(input);
    return {
      revoke: () => {
        void this.revokeCapability({ path: input.path });
      },
    };
  }

  revokeCapability(input: { path: string[] }): void | Promise<void> {
    return this.itxProcessor().revokeCapability(input);
  }

  runScript(code: string) {
    return this.itxProcessor().runScript(code);
  }

  [fallbackCall](path: (string | number)[], args: unknown[]) {
    return this.itxProcessor().invokeCapability({ args, path: path.map(String) });
  }

  #rejectBuiltinCollision(path: string[]) {
    const root = path[0];
    if (root && root in this) {
      throw new Error(`cannot provide capability "${root}": it is already on this ITX target`);
    }
  }
}

export class StreamTarget
  extends ProjectScopedRpcTarget
  implements RpcTargetImplementation<StreamContract>
{
  constructor(readonly streamProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super({ auth: streamProps.auth, projectId: streamProps.projectId });
  }

  async append(input: { event: StreamEventInput }): Promise<StreamEvent> {
    return (await globalStreams()
      .getByName(formatDurableObjectName(this.streamProps))
      .append(input)) as StreamEvent;
  }

  async appendBatch(input: { events: StreamEventInput[] }): Promise<StreamEvent[]> {
    return (await globalStreams()
      .getByName(formatDurableObjectName(this.streamProps))
      .appendBatch(input)) as StreamEvent[];
  }

  async getEvents(input?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): Promise<StreamEvent[]> {
    return (await globalStreams()
      .getByName(formatDurableObjectName(this.streamProps))
      .getEvents(input)) as StreamEvent[];
  }
}

export class StreamsTarget
  extends ProjectScopedRpcTarget
  implements RpcTargetImplementation<StreamsContract>
{
  get(path: string): StreamContract {
    return new StreamTarget({
      auth: this.auth,
      path,
      projectId: this.projectId,
    }) as unknown as StreamContract;
  }
}

export class RepoTarget
  extends ProjectScopedRpcTarget
  implements RpcTargetImplementation<RepoContract>
{
  constructor(readonly repoProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super({ auth: repoProps.auth, projectId: repoProps.projectId });
  }

  async create(): Promise<StreamEvent> {
    return (await globalRepos()
      .getByName(formatDurableObjectName(this.repoProps))
      .create()) as StreamEvent;
  }

  whoami() {
    return globalRepos()
      .getByName(formatDurableObjectName(this.repoProps))
      .whoami() as Promise<string>;
  }
}

export class ReposTarget
  extends ProjectScopedRpcTarget
  implements RpcTargetImplementation<ReposContract>
{
  get(path: string): RepoContract {
    return new RepoTarget({
      auth: this.auth,
      path,
      projectId: this.projectId,
    }) as unknown as RepoContract;
  }

  async create(input: { path: string }): Promise<StreamEvent> {
    return await new RepoTarget({
      auth: this.auth,
      path: input.path,
      projectId: this.projectId,
    }).create();
  }
}

export class ProjectWorkerTarget
  extends ProjectScopedRpcTarget
  implements RpcTargetImplementation<ProjectWorkerContract>
{
  fetch(req: Request) {
    return globalProjects().getByName(this.name("/")).workerFetch(req) as Promise<Response>;
  }

  async processEvent(input: { event: StreamEvent }): Promise<void> {
    await globalProjects().getByName(this.name("/")).workerProcessEvent(input);
  }
}

export class AgentTarget
  extends ItxCapabilityHostTarget
  implements RpcTargetImplementation<AgentContract>
{
  constructor(readonly agentProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super({ auth: agentProps.auth, projectId: agentProps.projectId });
  }

  get stream(): StreamContract {
    return new StreamTarget(this.agentProps) as unknown as StreamContract;
  }

  get itx(): AgentItxContract {
    return new AgentItx(this.agentProps) as unknown as AgentItxContract;
  }

  async create(): Promise<StreamEvent> {
    return (await globalAgents()
      .getByName(formatDurableObjectName(this.agentProps))
      .create()) as StreamEvent;
  }

  async sendMessage(message: string): Promise<StreamEvent> {
    return (await globalAgents()
      .getByName(formatDurableObjectName(this.agentProps))
      .sendMessage(message)) as unknown as StreamEvent;
  }

  whoami() {
    return globalAgents()
      .getByName(formatDurableObjectName(this.agentProps))
      .whoami() as Promise<string>;
  }

  protected itxProcessor() {
    return globalAgents().getByName(formatDurableObjectName(this.agentProps)).itxProcessor;
  }
}

export class AgentsTarget
  extends ProjectScopedRpcTarget
  implements RpcTargetImplementation<AgentsContract>
{
  get(path: string): AgentContract {
    return new AgentTarget({
      auth: this.auth,
      path,
      projectId: this.projectId,
    }) as unknown as AgentContract;
  }

  async create(input: { path: string }): Promise<StreamEvent> {
    return await new AgentTarget({
      auth: this.auth,
      path: input.path,
      projectId: this.projectId,
    }).create();
  }
}

export class ProjectItx
  extends ItxCapabilityHostTarget
  implements RpcTargetImplementation<ProjectContract>
{
  constructor(readonly projectProps: { auth: ItxAuthContext; path?: string; projectId: string }) {
    super({ auth: projectProps.auth, projectId: projectProps.projectId });
  }

  get streams(): StreamsContract {
    return new StreamsTarget({
      auth: this.auth,
      projectId: this.projectId,
    }) as unknown as StreamsContract;
  }

  get agents(): AgentsContract {
    return new AgentsTarget({
      auth: this.auth,
      projectId: this.projectId,
    }) as unknown as AgentsContract;
  }

  get repos(): ReposContract {
    return new ReposTarget({
      auth: this.auth,
      projectId: this.projectId,
    }) as unknown as ReposContract;
  }

  get repo(): RepoContract {
    return this.repos.get(PROJECT_REPO_PATH);
  }

  get worker(): ProjectWorkerContract {
    return new ProjectWorkerTarget({
      auth: this.auth,
      projectId: this.projectId,
    }) as unknown as ProjectWorkerContract;
  }

  async create(): Promise<StreamEvent> {
    return (await globalProjects().getByName(this.name("/")).create()) as StreamEvent;
  }

  protected itxProcessor() {
    return globalProjects().getByName(this.name("/")).itxProcessor;
  }
}

export class AgentItx extends ProjectItx implements RpcTargetImplementation<AgentItxContract> {
  constructor(readonly agentItxProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super(agentItxProps);
  }

  get agent(): AgentContract {
    return new AgentTarget({
      auth: this.auth,
      path: this.agentItxProps.path,
      projectId: this.projectId,
    }) as unknown as AgentContract;
  }
}

export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxConnectInput>
  implements Pick<RpcTargetImplementation<UnauthenticatedItxContract>, "authenticate">
{
  authenticate(input: ItxConnectInput = this.ctx.props) {
    return new UnauthenticatedItx(this.env).authenticate(input);
  }
}
