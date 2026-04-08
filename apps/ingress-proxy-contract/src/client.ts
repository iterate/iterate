import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

import { ingressProxyContract } from "./contract.ts";

export type IngressProxyClient = ContractRouterClient<typeof ingressProxyContract>;
type IngressProxyFetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

export function createIngressProxyClient(options: {
  baseURL: string;
  apiToken: string;
  fetch?: IngressProxyFetch;
}): IngressProxyClient {
  const authFetch: IngressProxyFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${options.apiToken}`);

    return (options.fetch ?? fetch)(input, {
      ...init,
      headers,
    });
  };

  const link = new OpenAPILink(ingressProxyContract, {
    url: new URL("/api", options.baseURL).toString(),
    fetch: authFetch,
  });

  return createORPCClient(link);
}
