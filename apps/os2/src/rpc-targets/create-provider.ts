/**
 * Helpers for constructing CallableToolProvider descriptors that point at
 * rpc-target WorkerEntrypoints via loopback bindings.
 *
 * These create the serializable JSON descriptors — not live ToolProvider
 * instances. The descriptors are resolved at dispatch time by
 * resolveCallableToolProvider() using CallableContext.exports.
 */

import type { CallableToolProvider } from "@iterate-com/shared/codemode/types";

/**
 * Create a CallableToolProvider backed by the OpenApiBridge entrypoint.
 *
 * The resulting descriptor uses loopback-binding callables with props
 * containing the spec URL and base URL. When dispatched, the callable
 * system resolves the "OpenApiBridge" export from ctx.exports and calls
 * execute/describe on it.
 *
 * Usage:
 *   const provider = createOpenApiProvider({
 *     path: ["petstore"],
 *     specUrl: "https://petstore.swagger.io/v2/swagger.json",
 *     baseUrl: "https://petstore.swagger.io/v2",
 *   });
 */
export function createOpenApiProvider(options: {
  path: string[];
  specUrl: string;
  baseUrl: string;
}): CallableToolProvider {
  const props = { specUrl: options.specUrl, baseUrl: options.baseUrl };
  const via = {
    type: "loopback-binding" as const,
    bindingType: "service" as const,
    exportName: "OpenApiBridge",
    props,
  };

  return {
    path: options.path,
    execute: {
      type: "workers-rpc" as const,
      via,
      rpcMethod: "execute",
    },
    describe: {
      type: "workers-rpc" as const,
      via,
      rpcMethod: "describe",
    },
  };
}
