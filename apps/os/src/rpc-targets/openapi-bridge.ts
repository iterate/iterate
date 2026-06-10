/**
 * OpenAPI bridge — a stateless WorkerEntrypoint that translates
 * codemode Function Calls into HTTP calls against an OpenAPI spec.
 *
 * Deployed as a named export from the os worker. Same-worker callables can
 * reach it via loopback-binding with props containing the spec URL and base URL:
 *
 *   { type: "loopback-binding", bindingType: "service",
 *     exportName: "OpenApiBridge", props: { specUrl, baseUrl } }
 *
 * Use createOpenApiProviderRegistration() from
 * `openapi-provider-registration.ts` to build the codemode registration. Rich
 * discovery is an ordinary function call: `ctx.petstore.listOperations()`.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { executeOpenApiToolFunction, type OpenApiBridgeProps } from "./openapi-bridge-core.ts";
import type { ExecuteCodemodeFunctionCallInput } from "~/domains/codemode/stream-processors/codemode/implementation.ts";
export { createOpenApiProviderRegistration } from "./openapi-provider-registration.ts";

export class OpenApiBridge extends WorkerEntrypoint<Record<string, unknown>, OpenApiBridgeProps> {
  /**
   * Execute a codemode function call against the OpenAPI spec.
   *
   * `functionPath[0]` is either `listOperations` or an operationId. The first
   * positional arg is used as request body/query/path params.
   */
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    return await executeOpenApiToolFunction({
      args: input.args,
      functionPath: input.functionPath,
      providerProps: this.resolveProviderProps(),
    });
  }

  private resolveProviderProps() {
    return this.ctx.props;
  }
}
