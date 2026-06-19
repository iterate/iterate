import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { fallbackCall } from "capnweb";
import { durableObjectProcessorSubscriber } from "../domains/streams/engine/shared/callable-subscriber.ts";
import type { Env } from "../env.ts";
import type {
  AgentItxRpc,
  AgentRpc,
  AgentsRpc,
  ItxConnectInput,
  ItxProcessorRpc,
  ProjectItxRpc,
  ProjectRpc,
  ProjectWorkerRpc,
  ProvideCapabilityInput,
  RepoRpc,
  ReposRpc,
  RootProjectsRpc,
  RootRpc,
  RunScriptResult,
  StreamEventInput,
  StreamRpc,
  StreamsRpc,
  UnauthenticatedItxRpc,
} from "../itx-types.ts";
import {
  authContextForPrincipal,
  PRINCIPALS,
  TRUSTED_INTERNAL_ITX_TOKEN,
  trustedInternalAuthContext,
  type ItxAuthContext,
} from "../auth.ts";
import { formatDurableObjectName } from "../domains/durable-object-names.ts";
import { ProjectProcessorContract } from "../domains/projects/project-processor.ts";
import { RepoProcessorContract } from "../domains/repos/repo-processor.ts";
import { ItxContract } from "./processor-contract.ts";

const PROJECT_REPO_PATH = "/repos/project";

export type RequestAuthContext = {
  serverCookieToken?: string | null;
};

export class UnauthenticatedItx extends RpcTarget implements UnauthenticatedItxRpc {
  constructor(
    readonly itxEnv: Env,
    readonly requestAuth: RequestAuthContext = {},
  ) {
    super();
  }

  authenticate(input: ItxConnectInput): RootRpc | ProjectItxRpc | AgentItxRpc {
    let auth: ItxAuthContext | null = null;

    if (input.auth.type === "token") {
      const principal = PRINCIPALS[input.auth.token];
      if (principal) auth = authContextForPrincipal(principal);
    }

    if (input.auth.type === "from-server-cookie") {
      const token = this.requestAuth.serverCookieToken ?? "";
      const principal = PRINCIPALS[token];
      if (principal) auth = authContextForPrincipal(principal);
    }

    if (input.auth.type === "trusted-internal" && input.auth.token === TRUSTED_INTERNAL_ITX_TOKEN) {
      auth = trustedInternalAuthContext();
    }

    if (!auth) throw new Error("missing or invalid auth");

    if (!input.projectId) {
      if (input.path) throw new Error("path requires projectId");
      return new Itx({ auth, env: this.itxEnv });
    }

    const path = input.path ?? "/";
    if (path === "/") return new ProjectItx({ auth, projectId: input.projectId });
    if (path.startsWith("/agents/")) {
      return new AgentItx({ auth, path, projectId: input.projectId });
    }
    throw new Error(`no ITX host for path "${path}"`);
  }
}

export class RootProjectsRpcTarget extends RpcTarget implements RootProjectsRpc {
  constructor(readonly props: { auth: ItxAuthContext; env: Env }) {
    super();
  }

  list() {
    return this.props.auth.listAccessibleProjects();
  }

  async create(projectId: string) {
    this.props.auth.requireCanCreateProject();
    const durableObjectName = formatDurableObjectName({ path: "/", projectId });
    const projectRepoName = formatDurableObjectName({ path: PROJECT_REPO_PATH, projectId });
    await this.props.env.STREAM.getByName(durableObjectName).appendBatch({
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
        },
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
        },
        {
          type: "events.iterate.com/project/created",
          idempotencyKey: `project-created:${projectId}`,
          payload: { projectId },
        },
      ],
    });
    await this.props.env.STREAM.getByName(projectRepoName).append({
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          subscriptionKey: `repo:${projectId}:${PROJECT_REPO_PATH}:${crypto.randomUUID()}`,
          subscriber: durableObjectProcessorSubscriber({
            bindingName: "REPO",
            durableObjectName: projectRepoName,
            processorName: RepoProcessorContract.slug,
          }),
        },
      },
    });
    await this.props.env.REPO.getByName(projectRepoName).create();
    return { id: projectId };
  }
}

export class Itx extends RpcTarget implements RootRpc {
  constructor(readonly props: { auth: ItxAuthContext; env: Env }) {
    super();
  }

  get projects() {
    return new RootProjectsRpcTarget(this.props);
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
}

export class ProjectRpcTarget extends ProjectScopedRpcTarget implements ProjectRpc {
  constructor(readonly projectProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super(projectProps);
  }

  egress(url: string, init?: RequestInit) {
    return env.PROJECT.getByName(formatDurableObjectName(this.projectProps)).egress(url, init);
  }

  repo() {
    return new RepoRpcTarget({
      auth: this.auth,
      path: PROJECT_REPO_PATH,
      projectId: this.projectId,
    });
  }

  get worker(): ProjectWorkerRpc {
    return new ProjectWorkerRpcTarget({ auth: this.auth, projectId: this.projectId });
  }
}

export class ProjectWorkerRpcTarget extends ProjectScopedRpcTarget implements ProjectWorkerRpc {
  add(a: number, b: number) {
    return env.PROJECT.getByName(
      formatDurableObjectName({ path: "/", projectId: this.projectId }),
    ).workerAdd(a, b);
  }

  greet(name?: string) {
    return env.PROJECT.getByName(
      formatDurableObjectName({ path: "/", projectId: this.projectId }),
    ).workerGreet(name);
  }
}

export class AgentRpcTarget extends ProjectScopedRpcTarget implements AgentRpc {
  constructor(readonly agentProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super(agentProps);
  }

  create(input: Record<string, unknown> = {}) {
    return env.AGENT.getByName(formatDurableObjectName(this.agentProps)).create(input);
  }

  project() {
    return new ProjectRpcTarget({ auth: this.auth, path: "/", projectId: this.projectId });
  }

  sendMessage(input: { channel?: string; message: string }) {
    return env.AGENT.getByName(formatDurableObjectName(this.agentProps)).sendMessage(input);
  }

  whoami() {
    return env.AGENT.getByName(formatDurableObjectName(this.agentProps)).whoami();
  }
}

export class RepoRpcTarget extends ProjectScopedRpcTarget implements RepoRpc {
  constructor(readonly repoProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super(repoProps);
  }

  create(input: Record<string, unknown> = {}) {
    return env.REPO.getByName(formatDurableObjectName(this.repoProps)).create(input);
  }

  whoami() {
    return env.REPO.getByName(formatDurableObjectName(this.repoProps)).whoami();
  }
}

export class StreamRpcTarget extends ProjectScopedRpcTarget implements StreamRpc {
  constructor(readonly streamProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super(streamProps);
  }

  append(args: { streamPath?: string; event: StreamEventInput }) {
    return env.STREAM.getByName(formatDurableObjectName(this.streamProps)).append(args);
  }

  appendBatch(args: { streamPath?: string; events: StreamEventInput[] }) {
    return env.STREAM.getByName(formatDurableObjectName(this.streamProps)).appendBatch(args);
  }

  getEvents(args?: { afterOffset?: number; beforeOffset?: number | null; limit?: number }) {
    return env.STREAM.getByName(formatDurableObjectName(this.streamProps)).getEvents(args);
  }
}

export class StreamsRpcTarget extends ProjectScopedRpcTarget implements StreamsRpc {
  get(path: string) {
    return new StreamRpcTarget({ auth: this.auth, path, projectId: this.projectId });
  }
}

abstract class ProjectContextItx extends ProjectScopedRpcTarget implements ProjectItxRpc {
  get project() {
    return new ProjectRpcTarget({ auth: this.auth, path: "/", projectId: this.projectId });
  }

  get streams() {
    return new StreamsRpcTarget({ auth: this.auth, projectId: this.projectId });
  }

  get agents() {
    return new AgentsRpcTarget({ auth: this.auth, projectId: this.projectId });
  }

  get repos() {
    return new ReposRpcTarget({ auth: this.auth, projectId: this.projectId });
  }

  get repo() {
    return this.repos.get(PROJECT_REPO_PATH);
  }

  get worker(): ProjectWorkerRpc {
    return new ProjectWorkerRpcTarget({ auth: this.auth, projectId: this.projectId });
  }

  async provideCapability(input: ProvideCapabilityInput) {
    this.#rejectBuiltinCollision(input.path);
    await this.itxProcessor().provideCapability(input);
    return { revoke: () => this.revokeCapability({ path: input.path }) };
  }

  revokeCapability(input: { path: string[] }): void | Promise<void> {
    return this.itxProcessor().revokeCapability(input);
  }

  runScript(input: { code: string }): RunScriptResult | Promise<RunScriptResult> {
    return this.itxProcessor().runScript(input);
  }

  [fallbackCall](path: (string | number)[], args: unknown[]) {
    return this.itxProcessor().invokeCapability({ args, path: path.map(String) });
  }

  protected abstract itxProcessor(): ItxProcessorRpc;

  protected name(path: string) {
    return formatDurableObjectName({ path, projectId: this.projectId });
  }

  #rejectBuiltinCollision(path: string[]) {
    const root = path[0];
    if (root && root in this) {
      throw new Error(`cannot provide capability "${root}": it is already on this ITX target`);
    }
  }
}

export class ProjectItx extends ProjectContextItx {
  protected itxProcessor() {
    return env.PROJECT.getByName(this.name("/")).itxProcessor;
  }
}

export class AgentItx extends ProjectContextItx implements AgentItxRpc {
  constructor(readonly agentItxProps: { auth: ItxAuthContext; path: string; projectId: string }) {
    super(agentItxProps);
  }

  get agent() {
    return new AgentRpcTarget({
      auth: this.auth,
      path: this.agentItxProps.path,
      projectId: this.projectId,
    });
  }

  protected itxProcessor() {
    return env.AGENT.getByName(
      formatDurableObjectName({
        path: this.agentItxProps.path,
        projectId: this.projectId,
      }),
    ).itxProcessor;
  }
}

export class AgentsRpcTarget extends ProjectScopedRpcTarget implements AgentsRpc {
  get(path: string) {
    return new AgentRpcTarget({ auth: this.auth, path, projectId: this.projectId });
  }

  create({ path, ...input }: { path: string; [key: string]: unknown }) {
    return this.get(path).create(input);
  }
}

export class ReposRpcTarget extends ProjectScopedRpcTarget implements ReposRpc {
  get(path: string) {
    return new RepoRpcTarget({ auth: this.auth, path, projectId: this.projectId });
  }

  create({ path, ...input }: { path: string; [key: string]: unknown }) {
    return this.get(path).create(input);
  }
}

export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxConnectInput>
  implements Pick<UnauthenticatedItxRpc, "authenticate">
{
  authenticate(input: ItxConnectInput = this.ctx.props) {
    return new UnauthenticatedItx(this.env).authenticate(input);
  }
}
