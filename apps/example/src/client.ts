import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { exampleContract } from "@iterate-com/example-contract";

export type ExampleClient = ContractRouterClient<typeof exampleContract>;

const FALLBACK_ORIGIN =
  typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:17401";

export function createExampleClient(params?: {
  url?: string;
  fetch?: typeof fetch;
}): ExampleClient {
  const base = params?.url ?? FALLBACK_ORIGIN;
  // Keep a single transport story for the example app: typed clients call the
  // OpenAPI-backed HTTP API, while raw websocket routes stay demo-only.
  const link = new OpenAPILink(exampleContract, {
    url: `${base}/api`,
    ...(params?.fetch ? { fetch: params.fetch } : {}),
  });
  return createORPCClient(link);
}
