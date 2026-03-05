import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createORPCReactQueryUtils } from "@orpc/react-query";
import type { RouterClient } from "@orpc/server";
import type { Router } from "@/server/router.ts";

const link = new RPCLink({
  url: typeof window !== "undefined" ? `${window.location.origin}/api/rpc` : "/api/rpc",
  method: "POST",
});

export const orpcClient: RouterClient<Router> = createORPCClient(link);

export const orpc = createORPCReactQueryUtils(orpcClient);
