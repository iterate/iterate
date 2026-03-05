import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import type { AppRouter } from "../../../daemon/server/orpc/app-router.ts";

export function createDaemonClient(params: {
  baseUrl: string;
  fetcher?: SandboxFetcher;
}): RouterClient<AppRouter> {
  const link = new RPCLink({
    url: `${params.baseUrl}/api/orpc`,
    ...(params.fetcher ? { fetch: params.fetcher as typeof globalThis.fetch } : {}),
  });
  return createORPCClient(link);
}
