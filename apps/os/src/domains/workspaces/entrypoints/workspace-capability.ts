import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  type CloudflareShellState,
  type WorkspaceDurableObject,
  type WorkspaceStructuredName,
} from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";

type WorkspaceCapabilityEnv = {
  WORKSPACE?: DurableObjectNamespace<WorkspaceDurableObject>;
};

export type WorkspaceCapabilityProps = {
  projectId: string;
  workspaceId: string;
};

type WorkspaceRpcStub = {
  cloudflareShellGit(): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>;
  cloudflareShellState(): Promise<CloudflareShellState>;
};

export class WorkspaceCapability extends WorkerEntrypoint<
  WorkspaceCapabilityEnv,
  WorkspaceCapabilityProps
> {
  #git?: WorkspaceGitCapability;

  get git() {
    return (this.#git ??= new WorkspaceGitCapability({
      getGit: async () => await (await this.workspace()).cloudflareShellGit(),
    }));
  }

  async gitAdd(input: Record<string, unknown>) {
    return await this.#callGit("add", input);
  }

  async gitClone(input: Record<string, unknown>) {
    return await this.#callGit("clone", input);
  }

  async gitCommit(input: Record<string, unknown>) {
    return await this.#callGit("commit", input);
  }

  async gitPush(input: Record<string, unknown>) {
    return await this.#callGit("push", input);
  }

  async gitStatus(input: Record<string, unknown>) {
    return await this.#callGit("status", input);
  }

  async readFile(path: string) {
    const state = await (await this.workspace()).cloudflareShellState();
    return await callMethod({
      args: [path],
      method: "readFile",
      namespace: "ctx.workspace",
      target: state as {},
    });
  }

  async writeFile(path: string, content: string) {
    const state = await (await this.workspace()).cloudflareShellState();
    return await callMethod({
      args: [path, content],
      method: "writeFile",
      namespace: "ctx.workspace",
      target: state as {},
    });
  }

  private async workspace(): Promise<WorkspaceRpcStub> {
    const namespace = this.requireWorkspaceNamespace();
    const name = this.workspaceName();
    return (await getInitializedDoStub({
      allowCreate: true,
      namespace,
      name,
    })) as unknown as WorkspaceRpcStub;
  }

  private workspaceName(): WorkspaceStructuredName {
    return {
      projectId: this.ctx.props.projectId,
      workspaceId: this.ctx.props.workspaceId,
    };
  }

  private requireWorkspaceNamespace() {
    if (!this.env.WORKSPACE) {
      throw new Error("WORKSPACE Durable Object namespace is not configured.");
    }

    return this.env.WORKSPACE;
  }

  async #callGit(method: string, input: Record<string, unknown>) {
    const git = await (await this.workspace()).cloudflareShellGit();
    return await callMethod({
      args: [input],
      method,
      namespace: "ctx.workspace.git",
      target: git,
    });
  }
}

class WorkspaceGitCapability extends RpcTarget {
  readonly #getGit: () => Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>;

  constructor(input: {
    getGit: () => Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>;
  }) {
    super();
    this.#getGit = input.getGit;
  }

  async add(input: Record<string, unknown>) {
    return await this.#call("add", [input]);
  }

  async clone(input: Record<string, unknown>) {
    return await this.#call("clone", [input]);
  }

  async commit(input: Record<string, unknown>) {
    return await this.#call("commit", [input]);
  }

  async push(input: Record<string, unknown>) {
    return await this.#call("push", [input]);
  }

  async status(input: Record<string, unknown>) {
    return await this.#call("status", [input]);
  }

  async #call(method: string, args: unknown[]) {
    return await callMethod({
      args,
      method,
      namespace: "ctx.workspace.git",
      target: await this.#getGit(),
    });
  }
}

async function callMethod(input: {
  args: unknown[];
  method: string;
  namespace: string;
  target: Record<string, unknown>;
}) {
  const fn = input.target[input.method];
  if (typeof fn !== "function") {
    throw new Error(`${input.namespace} does not implement ${input.method}.`);
  }

  return await fn(...input.args);
}
