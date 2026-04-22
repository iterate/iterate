import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { thingsContract } from "./contract";

let cachedClient: ReturnType<typeof createBrowserClient> | undefined;

function createBrowserClient() {
  return createORPCClient(
    new OpenAPILink(thingsContract, {
      url: `${window.location.origin}/api`,
    }),
  );
}

export function getOrpcClient() {
  if (typeof window === "undefined") {
    // SSR — no client available, queries will run client-side only
    return createORPCClient(new OpenAPILink(thingsContract, { url: "http://localhost/api" }));
  }
  cachedClient ??= createBrowserClient();
  return cachedClient;
}

export const orpc = createTanstackQueryUtils(getOrpcClient());
