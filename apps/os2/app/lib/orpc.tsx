import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { PropsWithChildren } from "react";
import type { AppRouter } from "../../backend/orpc/root.ts";

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

function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return process.env.VITE_PUBLIC_URL || "http://localhost:5173";
}

export function makeOrpcClient(): RouterClient<AppRouter> {
  const link = new RPCLink({
    url: `${getBaseUrl()}/api/orpc`,
  });
  return createORPCClient(link);
}

export function ORPCProvider({
  children,
  queryClient,
}: PropsWithChildren<{ queryClient: QueryClient }>) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export const orpcClient: RouterClient<AppRouter> = makeOrpcClient();
export const orpc = createTanstackQueryUtils(orpcClient);
