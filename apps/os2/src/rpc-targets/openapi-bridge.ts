/**
 * OpenAPI bridge — a stateless WorkerEntrypoint that translates
 * provider Tool Function calls into HTTP calls against an OpenAPI spec.
 *
 * Deployed as a named export from the os2 worker. Same-worker callables can
 * reach it via loopback-binding with props containing the spec URL and base URL:
 *
 *   { type: "loopback-binding", bindingType: "service",
 *     exportName: "OpenApiBridge", props: { specUrl, baseUrl } }
 *
 * Storable cross-worker descriptors use createOpenApiProvider({ workerScriptName })
 * and pass the same provider props in the RPC input instead. Regular Service
 * Bindings cannot receive dynamic ctx.props; only ctx.exports loopback bindings can.
 *
 * Use createOpenApiProvider() to construct the ToolProviderDescriptor.
 * The descriptor has one Callable; this bridge handles the reserved
 * `__describe` path inside executeToolFunction.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  DESCRIBE_TOOL_FUNCTION_NAME,
  type ToolProviderDescriptor,
} from "@iterate-com/shared/codemode/types";
import { createSelfToolProviderDescriptor } from "@iterate-com/shared/codemode/self-callable";
import {
  describeOpenApiToolFunctions,
  executeOpenApiToolFunction,
  type OpenApiBridgeInput,
  type OpenApiBridgeProps,
} from "./openapi-bridge-core.ts";

export class OpenApiBridge extends WorkerEntrypoint<Record<string, unknown>, OpenApiBridgeProps> {
  /**
   * Execute a tool function call against the OpenAPI spec.
   *
   * path[0] is either `__describe` or an operationId. payload is the request
   * body or query params.
   */
  async executeToolFunction(input: OpenApiBridgeInput) {
    if (input.path.length === 1 && input.path[0] === DESCRIBE_TOOL_FUNCTION_NAME) {
      return await describeOpenApiToolFunctions({
        providerProps: this.resolveProviderProps(input),
      });
    }

    return await executeOpenApiToolFunction({
      ...input,
      providerProps: this.resolveProviderProps(input),
    });
  }

  private resolveProviderProps(input?: { providerProps?: OpenApiBridgeProps }) {
    return input?.providerProps ?? this.ctx.props;
  }
}

/**
 * Construct a ToolProviderDescriptor that routes through the OpenApiBridge
 * entrypoint. Without `workerScriptName`, the descriptor uses same-worker
 * loopback props. With `workerScriptName`, it becomes a self-callable descriptor
 * that can be stored and dispatched by another worker.
 *
 *   createOpenApiProvider({
 *     path: ["petstore"],
 *     specUrl: "https://petstore.swagger.io/v2/swagger.json",
 *     baseUrl: "https://petstore.swagger.io/v2",
 *   })
 */
type OpenApiProviderOptions = {
  path: string[];
  specUrl: string;
  baseUrl: string;
} & (
  | {
      workerScriptName: string;
      bindingName?: string;
    }
  | {
      workerScriptName?: undefined;
      bindingName?: undefined;
    }
);

export function createOpenApiProvider(options: OpenApiProviderOptions): ToolProviderDescriptor {
  if (options.workerScriptName) {
    return createSelfToolProviderDescriptor({
      path: options.path,
      workerScriptName: options.workerScriptName,
      entrypoint: "OpenApiBridge",
      bindingName: options.bindingName,
      providerProps: {
        specUrl: options.specUrl,
        baseUrl: options.baseUrl,
      },
    });
  }

  const via = {
    type: "loopback-binding" as const,
    bindingType: "service" as const,
    exportName: "OpenApiBridge",
    props: { specUrl: options.specUrl, baseUrl: options.baseUrl },
  };

  return {
    path: options.path,
    callable: { type: "workers-rpc" as const, via, rpcMethod: "executeToolFunction" },
  };
}
