import { createTRPCContext } from "@trpc/tanstack-react-query";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, loggerLink } from "@trpc/client";
import { toast } from "sonner";
import type { AppRouter } from "../../backend/trpc/root.ts";

// TODO: wtf is this, why we need this
export type TrpcContextType = ReturnType<typeof createTRPCContext<AppRouter>>;
export const TrpcContext: TrpcContextType = createTRPCContext<AppRouter>();
export const { useTRPC, useTRPCClient } = TrpcContext;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
    mutations: {
      onError: (error) => {
        toast.error(error.message || "An error occurred");
      },
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
    loggerLink({ enabled: () => true }),
    httpBatchLink({
      url: getTrpcUrl(),
      methodOverride: "POST",
    }),
  ],
});
