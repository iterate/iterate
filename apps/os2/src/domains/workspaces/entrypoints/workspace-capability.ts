import { WorkerEntrypoint } from "cloudflare:workers";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import {
  getWorkspaceDurableObjectName,
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
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.length === 0) {
      throw new Error("WorkspaceCapability requires a workspace method path.");
    }

    if (input.functionPath[0] === "git") {
      const method = readSingleMethodName("ctx.workspace.git", input.functionPath.slice(1));
      const git = await (await this.workspace()).cloudflareShellGit();
      return await callMethod({
        method,
        namespace: "ctx.workspace.git",
        target: git,
        args: input.args,
      });
    }

    if (input.functionPath.join(".") === "proofOfConcept") {
      return await this.proofOfConcept(input.args);
    }

    const method = readSingleMethodName("ctx.workspace", input.functionPath);
    const state = await (await this.workspace()).cloudflareShellState();
    return await callMethod({
      method,
      namespace: "ctx.workspace",
      target: state,
      args: input.args,
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

  private async proofOfConcept(args: unknown[]) {
    const [request] = args as [{ callback?: (args: unknown) => unknown; message?: string }];
    const payload = {
      workspaceName: getWorkspaceDurableObjectName(this.workspaceName()),
      message: request?.message ?? "workspace proof of concept",
    };
    await request?.callback?.(payload);
    return payload;
  }
}

export function createWorkspaceProviderRegistration(input: {
  projectId: string;
  streamPath: string;
  workspaceId?: string;
}): ToolProviderRegistration {
  const workspaceId = input.workspaceId ?? defaultWorkspaceIdForCodemodeSession(input);
  return {
    path: ["workspace"],
    instructions:
      "Use ctx.workspace.<state method>(...) for durable workspace files, for example ctx.workspace.readFile(path), ctx.workspace.writeFile(path, content), ctx.workspace.applyEdits(edits). Use ctx.workspace.git.<command>(...) for Git commands, for example ctx.workspace.git.clone({ url, dir, depth, token }), ctx.workspace.git.add({ filepath, dir }), ctx.workspace.git.commit({ message, dir }), and ctx.workspace.git.push({ remote, ref, dir, token }).",
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "WorkspaceCapability",
          props: {
            projectId: input.projectId,
            workspaceId,
          },
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
  };
}

export function defaultWorkspaceIdForCodemodeSession(input: { streamPath: string }) {
  return `codemode-session:${input.streamPath}`;
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

function readSingleMethodName(namespace: string, path: string[]) {
  if (path.length !== 1 || path[0] == null || path[0].trim() === "") {
    throw new Error(`${namespace} expected a single method name, received ${path.join(".")}.`);
  }

  return path[0];
}
