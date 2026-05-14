import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";

export function createSandboxesProviderRegistration(input: {
  projectId: string;
}): ToolProviderRegistration {
  return {
    path: ["sandboxes"],
    instructions:
      "Use ctx.sandboxes.getInitialized({ slug }) to get a prepared raw Cloudflare Sandbox SDK handle. The handle has the normal Sandbox SDK methods such as exec(command, options), execStream(command, options), startProcess(command, options), listProcesses(), and destroy(). Use /workspace as the durable workspace root; the project iterate-config repo is cloned at /workspace/iterate-config. Use ctx.sandboxes.list({}) to list project sandboxes. Use ctx.sandboxes.get({ slug }).getInfo() only when you need metadata for an existing logical sandbox without preparing the runtime.",
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "service",
          bindingName: "SANDBOXES_CAPABILITY",
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
        transformInput: {
          shallowMerge: { projectId: input.projectId },
        },
      },
    },
  };
}
