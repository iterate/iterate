import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createORPCReactQueryUtils } from "@orpc/react-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@server/orpc/app-router.ts";

const link = new RPCLink({
  url: `${window.location.origin}/api/orpc`,
  method: "POST",
});

export const orpcClient: RouterClient<AppRouter> = createORPCClient(link);

export const orpc = createORPCReactQueryUtils(orpcClient);
