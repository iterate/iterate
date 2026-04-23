import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { appRouter } from "./router";
import type { RouterClient } from "@orpc/server";
import { appContract } from "./contract";

type Client = RouterClient<typeof appRouter>;

// OpenAPI client — for REST-style CRUD
export function createOpenApiClient(): Client {
  return createORPCClient(new OpenAPILink(appContract, { url: `${window.location.origin}/api` }));
}

// RPC client — for streaming (SSE via RPCLink)
export function createRpcClient(): Client {
  return createORPCClient(new RPCLink({ url: `${window.location.origin}/api/rpc` }));
}

let cached: Client | undefined;
export function getClient(): Client {
  if (typeof window === "undefined") {
    return createORPCClient(new OpenAPILink(appContract, { url: "http://localhost/api" }));
  }
  cached ??= createOpenApiClient();
  return cached;
}

export const orpc = createTanstackQueryUtils(getClient());
