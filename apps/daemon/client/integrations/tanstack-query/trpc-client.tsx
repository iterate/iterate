import superjson from "superjson";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { TRPCRouter } from "@server/trpc/router.ts";

const context: any = createTRPCContext<TRPCRouter>();

export const TRPCProvider = context.TRPCProvider;
// eslint-disable-next-line react-refresh/only-export-components -- Context exports are intentionally grouped with trpcClient
export const useTRPC = context.useTRPC;

// eslint-disable-next-line react-refresh/only-export-components -- trpcClient is intentionally exported alongside components for centralized tRPC configuration
export const trpcClient = createTRPCClient<TRPCRouter>({
  links: [
    httpBatchStreamLink({
      transformer: superjson,
      url: "api/trpc",
      methodOverride: "POST",
    }),
  ],
});
