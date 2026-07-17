import { QueryClient } from "@tanstack/react-query";

/**
 * One Query client policy for every Iterate React renderer.
 *
 * The browser dashboard and the OpenTUI client intentionally share these
 * defaults. Renderer-specific entrypoints own only where the provider mounts;
 * cache lifetime, refetch behavior, and mutation retries must not drift by
 * surface.
 */
export function createIterateQueryClient(): QueryClient {
  return new QueryClient({
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
  });
}
