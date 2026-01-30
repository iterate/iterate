import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { api } from "./contract.ts";

export function createClient(
  url = process.env.PIDNAP_RPC_URL ?? "http://localhost:9876/rpc",
): ContractRouterClient<typeof api> {
  const authToken = process.env.PIDNAP_AUTH_TOKEN;
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  const link = new RPCLink({ url, headers });
  return createORPCClient(link);
}

export type Client = ReturnType<typeof createClient>;
