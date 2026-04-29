/**
 * OpenAPI bridge — a stateless WorkerEntrypoint that translates
 * ToolProvider.executeToolFunction(path, payload) into HTTP calls against an OpenAPI spec.
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
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
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
   * path[0] is the operationId. payload is the request body or query params.
   */
  async executeToolFunction(input: OpenApiBridgeInput) {
    return await executeOpenApiToolFunction({
      ...input,
      providerProps: this.resolveProviderProps(input),
    });
  }

  /**
   * Describe the available operations as TypeScript declarations.
   */
  async describeToolFunctions(input?: { providerProps?: OpenApiBridgeProps }) {
    return await describeOpenApiToolFunctions({ providerProps: this.resolveProviderProps(input) });
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
    executeToolFunction: { type: "workers-rpc" as const, via, rpcMethod: "executeToolFunction" },
    describeToolFunctions: {
      type: "workers-rpc" as const,
      via,
      rpcMethod: "describeToolFunctions",
    },
  };
}
