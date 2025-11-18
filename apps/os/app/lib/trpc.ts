import { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient } from "@trpc/client";
import { loggerLink, unstable_localLink as localLink, httpBatchLink } from "@trpc/client";
import { getContext } from "hono/context-storage";
import { createContext } from "../../backend/trpc/context.ts";
import { appRouter, type AppRouter } from "../../backend/trpc/root.ts";
import type { Variables } from "../../backend/worker.ts";
import type { CloudflareEnv } from "../../env.ts";

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

export const makeTrpcClient = createIsomorphicFn()
  .server(() =>
    createTRPCClient<AppRouter>({
      links: [
        // Its annoying to have these logs in server, if you need it, uncomment this
        // loggerLink({ enabled: () => true }),
        localLink({
          router: appRouter,
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
        loggerLink({ enabled: () => true }),
        httpBatchLink({
          url: `${window.location.origin}/api/trpc`,
          methodOverride: "POST",
        }),
      ],
    }),
  );

export const { useTRPC, useTRPCClient, TRPCProvider } = createTRPCContext<AppRouter>();

export type TRPCClient = ReturnType<typeof useTRPCClient>;
