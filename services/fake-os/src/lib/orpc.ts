import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { inferRPCMethodFromContractRouter } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import { fakeOsContract } from "@iterate-com/fake-os-contract";
import type { Router } from "@/server/router.ts";

const link = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
  method: inferRPCMethodFromContractRouter(fakeOsContract),
});

export const orpcClient: RouterClient<Router> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(orpcClient);
