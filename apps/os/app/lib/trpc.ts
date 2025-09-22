import { createTRPCContext } from "@trpc/tanstack-react-query";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, loggerLink } from "@trpc/client";
import type { AppRouter } from "../../backend/trpc/root.ts";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

const getTrpcUrl = () => {
  if (import.meta.env.SSR) {
    return `${import.meta.env.VITE_PUBLIC_URL}/api/trpc`;
  }
  return `${window.location.origin}/api/trpc`;
};

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: getTrpcUrl(),
      methodOverride: "POST",
    }),
    loggerLink({ enabled: () => true }),
  ],
});
