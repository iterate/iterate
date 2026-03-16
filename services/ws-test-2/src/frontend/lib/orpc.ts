import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import { contract } from "@/api/router.ts";
import type { router } from "@/api/router.ts";

const url =
  typeof window === "undefined"
    ? "http://127.0.0.1/api/rpc"
    : new URL("/api/rpc", window.location.origin).toString();

export const orpcClient: RouterClient<typeof router> = createORPCClient(
  new OpenAPILink(contract, {
    url,
  }),
);
export const orpc = createTanstackQueryUtils(orpcClient);
