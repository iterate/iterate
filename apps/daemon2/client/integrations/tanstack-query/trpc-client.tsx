/* eslint-disable react-refresh/only-export-components -- TRPC client setup requires exporting both component and utilities */
import type * as React from "react";
import superjson from "superjson";
import { type TRPCClient, createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { TRPCRouter } from "@server/trpc/router.ts";

export const trpcClient = createTRPCClient<TRPCRouter>({
  links: [
    httpBatchStreamLink({
      transformer: superjson,
      url: "/api/trpc",
      methodOverride: "POST",
    }),
  ],
});

// Explicit type annotation avoids TS2742 type portability error
const trpcContext = createTRPCContext<TRPCRouter>();
export const TRPCProvider: React.FC<{
  children: React.ReactNode;
  trpcClient: TRPCClient<TRPCRouter>;
  queryClient: QueryClient;
}> = trpcContext.TRPCProvider;
export const useTRPC = trpcContext.useTRPC;
