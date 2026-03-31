import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

import { daemonV2Contract } from "./contract.ts";

export type DaemonClient = ContractRouterClient<typeof daemonV2Contract>;
type DaemonFetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

export function createDaemonClient(options: { url: string; fetch?: DaemonFetch }): DaemonClient {
  const link = new OpenAPILink(daemonV2Contract, {
    url: options.url,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
}
