import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCLink } from "@orpc/client/fetch";
import { ClientRetryPlugin } from "@orpc/client/plugins";
import type { WorkerContract } from "./contract.ts";

/**
 * Create an oRPC client for calling the worker API. Uses environment variables for authentication and retries by default. Use RPCLink directly if you want to customise.
 */
export function createWorkerClient(): ContractRouterClient<WorkerContract> {
  const link = new RPCLink({
    url: `${process.env.ITERATE_OS_BASE_URL}/api/orpc`,
    headers: {
      Authorization: `Bearer ${process.env.ITERATE_OS_API_KEY}`,
    },
    plugins: [new ClientRetryPlugin()],
  });

  return createORPCClient(link);
}
