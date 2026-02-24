import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { servicesContract } from "@jonasland5/services-contract";

const DEFAULT_SERVICES_CLIENT_HOST = "127.0.0.1";
const DEFAULT_SERVICES_PORT = 8777;

export type ServicesClient = ContractRouterClient<typeof servicesContract>;

export function createServicesClient(params?: {
  url?: string;
  fetch?: (request: Request) => Promise<Response>;
}): ServicesClient {
  const url =
    params?.url ?? `http://${DEFAULT_SERVICES_CLIENT_HOST}:${String(DEFAULT_SERVICES_PORT)}/rpc`;
  const link = new RPCLink({ url, ...(params?.fetch ? { fetch: params.fetch } : {}) });
  return createORPCClient(link);
}
