import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";

export function createSandboxesProviderRegistration(input: {
  projectId: string;
}): ToolProviderRegistration {
  return {
    path: ["sandboxes"],
    instructions:
      "Use ctx.sandboxes.exec({ slug, exec: { command, cwd?, env?, timeout? } }) to lazily start a prepared Cloudflare Sandbox, mount /workspace, clone /workspace/iterate-config, and run a shell command. Use ctx.sandboxes.create({ slug }) to create logical sandbox metadata, ctx.sandboxes.wake({ slug }) to prepare the runtime without running a command, and ctx.sandboxes.list({}) to list project sandboxes. The durable workspace root is /workspace, and the project iterate-config repo is cloned at /workspace/iterate-config before exec runs.",
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "SandboxesCapability",
          props: { projectId: input.projectId },
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
  };
}
