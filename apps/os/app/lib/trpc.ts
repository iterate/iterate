import { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "../../backend/trpc/root.ts";

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

export const { useTRPC, useTRPCClient, TRPCProvider } = createTRPCContext<AppRouter>();

export type TRPCClient = ReturnType<typeof useTRPCClient>;

export const getTrpcUrl = createIsomorphicFn()
  .server(() => `${import.meta.env.VITE_PUBLIC_URL}/api/trpc`)
  .client(() => `${window.location.origin}/api/trpc`);
