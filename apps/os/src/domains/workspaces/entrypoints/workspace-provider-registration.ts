import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";

export function createWorkspaceProviderRegistration(input: {
  projectId: string;
  streamPath: string;
  workspaceId?: string;
}): ToolProviderRegistration {
  const workspaceId = input.workspaceId ?? defaultWorkspaceIdForCodemodeSession(input);
  return {
    path: ["workspace"],
    instructions:
      "Use ctx.workspace.<state method>(...) for durable workspace files under the canonical /workspace root. The project iterate-config repo is cloned at /workspace/iterate-config. For example ctx.workspace.readFile('/workspace/iterate-config/iterate.config.jsonc'), ctx.workspace.writeFile(path, content), and ctx.workspace.applyEdits(edits). Use ctx.workspace.git.<command>(...) for Git commands, for example ctx.workspace.git.clone({ url, dir, depth, token }), ctx.workspace.git.add({ filepath, dir }), ctx.workspace.git.commit({ message, dir }), and ctx.workspace.git.push({ remote, ref, dir, token }).",
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
