import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import superjson from "superjson";
import type { AppRouter } from "../../backend/trpc/root.ts";

// Vanilla client for direct server calls
export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
    }),
  ],
});

// React Query integration - uses the vanilla client under the hood
export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
});
