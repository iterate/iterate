import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { orpcRouter } from "@server/trpc/router.ts";

const link = new RPCLink({
  url: "api/trpc",
  method: "POST",
});

export const orpcClient: RouterClient<typeof orpcRouter> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(orpcClient);
