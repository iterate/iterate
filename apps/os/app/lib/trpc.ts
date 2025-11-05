import { createTRPCContext } from "@trpc/tanstack-react-query";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, loggerLink } from "@trpc/client";
import { toast } from "sonner";
import type { AppRouter } from "../../backend/trpc/root.ts";

// TODO: wtf is this, why we need this
export type TrpcContextType = ReturnType<typeof createTRPCContext<AppRouter>>;
export const TrpcContext: TrpcContextType = createTRPCContext<AppRouter>();
export const { useTRPC, useTRPCClient } = TrpcContext;

export const makeQueryClient = () =>
  new QueryClient({
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

let browserQueryClient: QueryClient | undefined = undefined;
export function getQueryClient() {
  if (import.meta.env.SSR) {
    // Server: always make a new query client
    return makeQueryClient();
  } else {
    // Browser: make a new query client if we don't already have one
    // This is very important, so we don't re-make a new client if React
    // suspends during the initial render. This may not be needed if we
    // have a suspense boundary BELOW the creation of the query client
    if (!browserQueryClient) browserQueryClient = makeQueryClient();
    return browserQueryClient;
  }
}

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
