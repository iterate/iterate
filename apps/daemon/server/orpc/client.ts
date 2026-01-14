import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCLink } from "@orpc/client/fetch";
import type { WorkerContract } from "./contract.ts";

/**
 * Create an oRPC client for calling the worker API.
 *
 * @param baseUrl - Base URL of the worker (e.g., "https://iterate.com" or "http://localhost:5173")
 * @param apiKey - Machine API key for authentication
 */
export function createWorkerClient(
  baseUrl: string,
  apiKey: string,
): ContractRouterClient<WorkerContract> {
  const link = new RPCLink({
    url: `${baseUrl}/api/orpc`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  return createORPCClient(link);
}
