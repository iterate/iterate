import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { fallbackCall } from "capnweb";
import type { Env } from "../env.ts";
import type {
  AgentItxRpc,
  AgentsRpc,
  ItxProcessorRpc,
  ProjectItxRpc,
  ProvideCapabilityInput,
  ReposRpc,
  RunScriptResult,
} from "../itx-types.ts";
import { formatDurableObjectName } from "../domains/durable-object-names.ts";
import { AgentRpcTarget } from "../domains/agents/agent-durable-object.ts";
import { ProjectRpcTarget } from "../domains/projects/project-durable-object.ts";
import { RepoRpcTarget } from "../domains/repos/repo-durable-object.ts";
import { StreamsRpcTarget } from "../domains/streams/streams-rpc-target.ts";

abstract class ItxRpcTarget extends RpcTarget implements ProjectItxRpc {
  constructor(readonly projectId: string) {
    super();
  }

  get project() {
    return new ProjectRpcTarget({ path: "/", projectId: this.projectId });
  }

  get streams() {
    return new StreamsRpcTarget(this.projectId);
  }

  get agents() {
    return new AgentsRpcTarget(this.projectId);
  }

  get repos() {
    return new ReposRpcTarget(this.projectId);
  }

  get repo() {
    return this.repos.get("/repos/project");
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

export class ProjectItxRpcTarget extends ItxRpcTarget {
  protected itxProcessor() {
    return env.PROJECT.getByName(this.name("/")).itxProcessor;
  }
}

export class AgentItxRpcTarget extends ItxRpcTarget implements AgentItxRpc {
  constructor(
    projectId: string,
    readonly path: string,
  ) {
    super(projectId);
  }

  get agent() {
    return new AgentRpcTarget({ path: this.path, projectId: this.projectId });
  }

  protected itxProcessor() {
    return env.AGENT.getByName(
      formatDurableObjectName({
        path: this.path,
        projectId: this.projectId,
      }),
    ).itxProcessor;
  }
}

export class AgentsRpcTarget extends RpcTarget implements AgentsRpc {
  constructor(readonly projectId: string) {
    super();
  }

  get(path: string) {
    return new AgentRpcTarget({ path, projectId: this.projectId });
  }

  create({ path, ...input }: { path: string; [key: string]: unknown }) {
    return this.get(path).create(input);
  }
}

export class ReposRpcTarget extends RpcTarget implements ReposRpc {
  constructor(readonly projectId: string) {
    super();
  }

  get(path: string) {
    return new RepoRpcTarget({ path, projectId: this.projectId });
  }

  create({ path, ...input }: { path: string; [key: string]: unknown }) {
    return this.get(path).create(input);
  }
}

export class ItxEntrypoint extends WorkerEntrypoint<Env, { path: string; projectId: string }> {
  get() {
    const { path, projectId } = this.ctx.props;
    if (path === "/") return new ProjectItxRpcTarget(projectId);
    if (path.startsWith("/agents/")) return new AgentItxRpcTarget(projectId, path);
    throw new Error(`no ITX host for path "${path}"`);
  }
}
