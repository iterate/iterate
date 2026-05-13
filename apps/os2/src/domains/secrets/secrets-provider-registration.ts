import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";

export function createSecretsProviderRegistration(input: {
  projectId: string;
}): ToolProviderRegistration {
  return {
    path: ["secrets"],
    instructions:
      "Use ctx.secrets.getSecret({ key }) to read raw project Secret material and metadata. Use ctx.secrets.create({ key, material, metadata? }), ctx.secrets.update({ key, material, metadata? }), ctx.secrets.list({}), and ctx.secrets.delete({ key }) to manage project Secrets.",
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "SecretsCapability",
          props: { projectId: input.projectId },
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
  };
}
