/**
 * OpenAPI bridge — a stateless WorkerEntrypoint that translates itx path-calls
 * into HTTP calls against an OpenAPI spec.
 *
 * Deployed as a named export from the os worker. Same-worker callables can
 * reach it via loopback-binding with props containing the spec URL and base URL:
 *
 *   { type: "loopback-binding", bindingType: "service",
 *     exportName: "OpenApiBridge", props: { specUrl, baseUrl } }
 *
 * Rich discovery is an ordinary function call: `ctx.petstore.listOperations()`.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { executeOpenApiToolFunction, type OpenApiBridgeProps } from "./openapi-bridge-core.ts";

export class OpenApiBridge extends WorkerEntrypoint<Record<string, unknown>, OpenApiBridgeProps> {
  /**
   * Execute an itx path-call against the OpenAPI spec.
   *
   * `path[0]` is either `listOperations` or an operationId. The first
   * positional arg is used as request body/query/path params.
   */
  async call(input: { args: unknown[]; path: string[] }): Promise<unknown> {
    return await executeOpenApiToolFunction({
      args: input.args,
      path: input.path,
      providerProps: this.resolveProviderProps(),
    });
  }

  private resolveProviderProps() {
    return this.ctx.props;
  }
}
