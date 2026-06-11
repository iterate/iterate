import { WorkerEntrypoint } from "cloudflare:workers";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  type CloudflareShellState,
  type WorkspaceDurableObject,
  type WorkspaceStructuredName,
} from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import { isChildContextId, type PathCall } from "~/itx/protocol.ts";

type WorkspaceCapabilityEnv = {
  WORKSPACE?: DurableObjectNamespace<WorkspaceDurableObject>;
};

export type WorkspaceCapabilityProps = {
  projectId: string;
  /** Explicit workspace; absent means derive from `context` (see below). */
  workspaceId?: string;
  /** Attribution, injected by the registry at dial time — and the workspace
   * scope: project contexts share one workspace ("itx"), child contexts each
   * get their own (`itx:ctx_…`), so an agent session's repo clones and files
   * are isolated per context. Chain delegation carries the ORIGINATING
   * context, which is what makes this derivation correct for caps inherited
   * from platform:project. */
  context?: string;
  capability?: string;
};

/** Project contexts share one workspace; child contexts are isolated. */
export function itxWorkspaceId(contextId: string): string {
  return isChildContextId(contextId) ? `itx:${contextId}` : "itx";
}

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
    const props = this.ctx.props;
    const workspaceId = props.workspaceId ?? (props.context ? itxWorkspaceId(props.context) : null);
    if (!workspaceId) {
      throw new Error("WorkspaceCapability needs props.workspaceId or props.context.");
    }
    return {
      projectId: props.projectId,
      workspaceId,
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
