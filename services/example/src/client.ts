import type { ContractRouterClient } from "@orpc/contract";
import { exampleContract, exampleServiceManifest } from "@iterate-com/example-contract";
import { createOrpcRpcServiceClient } from "@iterate-com/shared/jonasland";

export type ExampleClient = ContractRouterClient<typeof exampleContract>;

export function createExampleClient(params?: {
  url?: string;
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
}): ExampleClient {
  return createOrpcRpcServiceClient({
    env: {
      ...(params?.baseUrl ? { ITERATE_PROJECT_BASE_URL: params.baseUrl } : {}),
    },
    manifest: exampleServiceManifest,
    ...(params?.url ? { url: params.url } : {}),
    ...(params?.fetch ? { fetch: params.fetch } : {}),
  });
}
