import superjson from "superjson";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { TRPCRouter } from "@server/trpc/router.ts";

const context: any = createTRPCContext<TRPCRouter>();
export const TRPCProvider = context.TRPCProvider;
export const useTRPC = context.useTRPC;

export const trpcClient = createTRPCClient<TRPCRouter>({
  links: [
    httpBatchStreamLink({
      transformer: superjson,
      url: "api/trpc",
      methodOverride: "POST",
    }),
  ],
});
