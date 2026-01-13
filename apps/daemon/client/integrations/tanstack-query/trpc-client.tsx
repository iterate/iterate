import superjson from "superjson";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { TRPCRouter } from "@server/trpc/router.ts";

export const { TRPCProvider, useTRPC } = createTRPCContext<TRPCRouter>();

export const trpcClient = createTRPCClient<TRPCRouter>({
  links: [
    httpBatchStreamLink({
      transformer: superjson,
      url: "api/trpc",
      methodOverride: "POST",
    }),
  ],
});
