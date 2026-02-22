import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createORPCReactQueryUtils } from "@orpc/react-query";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getContext } from "hono/context-storage";
import type { PropsWithChildren } from "react";
import { appRouter, type AppRouter } from "../../backend/orpc/root.ts";
import { createContext } from "../../backend/orpc/context.ts";
import type { Variables } from "../../backend/types.ts";
import type { CloudflareEnv } from "../../env.ts";

/* eslint-disable react-refresh/only-export-components -- not sure if this is actually bad */

const defaultQueryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      gcTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
};

export function makeQueryClient() {
  return new QueryClient(defaultQueryClientConfig);
}

/**
 * Isomorphic oRPC client:
 * - Server: uses `createRouterClient` for direct in-process calls (no HTTP overhead during SSR)
 * - Client: uses `createORPCClient` + `RPCLink` for browser→server HTTP calls
 */
export const makeOrpcClient = createIsomorphicFn()
  .server(
    () =>
      createRouterClient(appRouter, {
        context: async () => {
          const c = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();
          return createContext(c);
        },
      }) as RouterClient<AppRouter>,
  )
  .client(
    (): RouterClient<AppRouter> =>
      createORPCClient(
        new RPCLink({
          url: `${window.location.origin}/api/orpc`,
          // oRPC handles Date, BigInt, Set, Map natively — no transformer needed
        }),
      ),
  );

/** React Query utils — provides `.queryOptions()`, `.mutationOptions()`, `.key()` etc. */
export function makeOrpc(_queryClient: QueryClient, orpcClient: ReturnType<typeof makeOrpcClient>) {
  return createORPCReactQueryUtils(orpcClient);
}

export function ORPCProvider({
  children,
  queryClient,
}: PropsWithChildren<{ queryClient: QueryClient }>) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export const orpcClient = makeOrpcClient();
export const orpc = createORPCReactQueryUtils(orpcClient);
