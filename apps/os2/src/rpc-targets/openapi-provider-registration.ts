import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";

export function createOpenApiProviderRegistration(options: {
  baseUrl: string;
  instructions?: string;
  path: string[];
  specUrl: string;
}): ToolProviderRegistration {
  return {
    instructions:
      options.instructions ??
      `Use ctx.${options.path.join(".")} to call the OpenAPI service at ${options.baseUrl}. Call listOperations() first to inspect available operations.`,
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "OpenApiBridge",
          // OpenAPI specs are provider configuration, not authority by
          // themselves. The actual authority is the same-worker loopback
          // binding supplied through CodemodeSession's callable context.
          props: { specUrl: options.specUrl, baseUrl: options.baseUrl },
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
    path: options.path,
  };
}
