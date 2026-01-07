import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { PropsWithChildren } from "react";
import superjson from "superjson";
import type { AppRouter } from "../../backend/trpc/root.ts";

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

export function makeTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        maxURLLength: 2083,
      }),
    ],
  });
}

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
export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient });
