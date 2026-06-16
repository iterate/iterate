import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type CloudflareShellState,
  getWorkspaceDurableObjectName,
  type WorkspaceDurableObject,
} from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import type { PathCall } from "~/itx/itx.ts";

type WorkspaceCapabilityEnv = {
  WORKSPACE?: DurableObjectNamespace<WorkspaceDurableObject>;
};

export type WorkspaceCapabilityProps = {
  projectId: string;
  /**
   * The workspace stream path this capability is bound to. This is explicit:
   * whoever provides the capability chooses the canonical `{ projectId, path }`
   * identity, for example `{ projectId: "proj_123", path: "/workspaces/project" }`.
   */
  path: string;
  /** Attribution, injected at dial time. */
  context?: string;
  capabilityPath?: string;
};

type WorkspaceRpcStub = {
  cloudflareShellGit(): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>;
  cloudflareShellState(): Promise<CloudflareShellState>;
};

export class WorkspaceCapability extends WorkerEntrypoint<
  WorkspaceCapabilityEnv,
  WorkspaceCapabilityProps
> {
  /** The itx kernel's one calling convention; replay walks this entrypoint's own members. */
  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this, input);
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
      targetName: "itx.workspace",
      target: state as {},
    });
  }

  async writeFile(path: string, content: string) {
    const state = await (await this.workspace()).cloudflareShellState();
    return await callMethod({
      args: [path, content],
      method: "writeFile",
      targetName: "itx.workspace",
      target: state as {},
    });
  }

  private async workspace(): Promise<WorkspaceRpcStub> {
    const namespace = this.requireWorkspaceNamespace();
    const name = getWorkspaceDurableObjectName(this.workspaceName());
    return namespace.getByName(name) as unknown as WorkspaceRpcStub;
  }

  private workspaceName(): { path: string; projectId: string } {
    const props = this.ctx.props;
    if (!props.path) {
      throw new Error("WorkspaceCapability needs provider props.path.");
    }
    return {
      path: props.path,
      projectId: props.projectId,
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
      targetName: "itx.workspace.git",
      target: git,
    });
  }
}

async function callMethod(input: {
  args: unknown[];
  method: string;
  targetName: string;
  target: Record<string, unknown>;
}) {
  const fn = input.target[input.method];
  if (typeof fn !== "function") {
    throw new Error(`${input.targetName} does not implement ${input.method}.`);
  }

  return await fn(...input.args);
}
