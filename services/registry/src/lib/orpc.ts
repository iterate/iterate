import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import { registryContract } from "@iterate-com/registry-contract";
import type { Router } from "@/server/router.ts";

const link = new OpenAPILink(registryContract, {
  url: "/api",
});

export const orpcClient: RouterClient<Router> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(orpcClient);
