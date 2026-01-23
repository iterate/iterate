import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, unstable_localLink as localLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getContext } from "hono/context-storage";
import type { PropsWithChildren } from "react";
import superjson from "superjson";
import { appRouter, type AppRouter } from "../../backend/trpc/root.ts";
import { createContext } from "../../backend/trpc/context.ts";
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

export const makeTrpcClient = createIsomorphicFn()
  .server(() =>
    createTRPCClient<AppRouter>({
      links: [
        localLink({
          router: appRouter,
          transformer: superjson,
          createContext: async () => {
            const c = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();
            return createContext(c);
          },
        }),
      ],
    }),
  )
  .client(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${window.location.origin}/api/trpc`,
          transformer: superjson,
          maxURLLength: 2083,
        }),
      ],
    }),
  );

export function makeTrpc(queryClient: QueryClient, trpcClient: ReturnType<typeof makeTrpcClient>) {
  return createTRPCOptionsProxy<AppRouter>({
    client: trpcClient,
    queryClient,
  });
}

export function TRPCProvider({
  children,
  queryClient,
}: PropsWithChildren<{ queryClient: QueryClient }>) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export const trpcClient = makeTrpcClient();
export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient: makeQueryClient(),
});
