import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

import { ingressProxyContract } from "./contract.ts";

export type IngressProxyClient = ContractRouterClient<typeof ingressProxyContract>;
export type IngressProxyFetch = (
  input: URL | string | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createIngressProxyClient(options: {
  baseURL: string;
  apiToken: string;
  fetch?: IngressProxyFetch;
}): IngressProxyClient {
  const link = new OpenAPILink(ingressProxyContract, {
    url: new URL("/api", options.baseURL).toString(),
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
}
