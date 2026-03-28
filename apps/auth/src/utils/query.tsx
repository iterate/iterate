import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { createORPCClient } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../server/orpc/index.ts";

const queryClientOptions: QueryClientConfig = {
  defaultOptions: {
    queries: {
      retry: 1,
    },
  },
};

let queryClient: QueryClient | null = null;

export const makeQueryClient = createIsomorphicFn()
  .client(() => (queryClient ??= new QueryClient(queryClientOptions)))
  .server(() => new QueryClient(queryClientOptions));

const link = new RPCLink({
  url: new URL(
    "/api/orpc",
    import.meta.env.SSR ? import.meta.env.VITE_AUTH_APP_ORIGIN : window.location.origin,
  ).toString(),
});

export const orpcClient: RouterClient<AppRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(orpcClient);
