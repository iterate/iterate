import type { ToolProviderRegistration } from "~/domains/codemode/stream-processors/codemode/contract.ts";

export function createOpenApiProviderRegistration(options: {
  baseUrl: string;
  headers?: Record<string, string>;
  instructions?: string;
  path: string[];
  specUrl: string;
}): ToolProviderRegistration {
  const props = {
    baseUrl: options.baseUrl,
    specUrl: options.specUrl,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  };

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
          props,
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
    path: options.path,
  };
}
