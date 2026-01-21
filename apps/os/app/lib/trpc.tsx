import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getContext } from "hono/context-storage";
import type { PropsWithChildren } from "react";
import { appRouter } from "../../backend/trpc/root.ts";
import { createContext } from "../../backend/trpc/context.ts";
import type { Variables } from "../../backend/worker.ts";
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

// Server-side: use createRouterClient for direct calls (no HTTP)
// Client-side: use createORPCClient with RPCLink (HTTP)
export const makeTrpcClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(appRouter, {
      context: async () => {
        const c = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();
        return createContext(c);
      },
    }),
  )
  .client((): RouterClient<typeof appRouter> => {
    const link = new RPCLink({
      url: `${window.location.origin}/api/trpc`,
    });
    return createORPCClient(link);
  });

export function makeTrpc(_queryClient: QueryClient, trpcClient: ReturnType<typeof makeTrpcClient>) {
  return createTanstackQueryUtils(trpcClient);
}

export function TRPCProvider({
  children,
  queryClient,
}: PropsWithChildren<{ queryClient: QueryClient }>) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export const trpcClient = makeTrpcClient();
export const trpc = createTanstackQueryUtils(trpcClient);
