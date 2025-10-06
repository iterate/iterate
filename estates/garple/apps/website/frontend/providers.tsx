import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState } from "react";
import superjson from "superjson";
import type { AppRouter } from "../backend/trpc/index.ts";

const { TRPCProvider, useTRPC: useTRPCInternal, useTRPCClient } = createTRPCContext<AppRouter>();

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- hooks must be exported from same file as provider
export function useTRPC() {
  return useTRPCInternal();
}

// eslint-disable-next-line react-refresh/only-export-components -- hooks must be exported from same file as provider
export { useTRPCClient };
