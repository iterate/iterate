import type { ReactNode } from "react";
import { createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { TRPCRouter } from "@server/trpc/router.ts";
import { routeTree } from "./routeTree.gen.ts";
import { trpcClient } from "./integrations/tanstack-query/trpc-client.tsx";
import { Provider } from "./integrations/tanstack-query/root-provider.tsx";

export interface RouterContext {
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy<TRPCRouter>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    dehydrate: { serializeData: superjson.serialize },
    hydrate: { deserializeData: superjson.deserialize },
  },
});

const trpc = createTRPCOptionsProxy({
  client: trpcClient,
  queryClient,
});

export const router = createRouter({
  routeTree,
  context: {
    queryClient,
    trpc,
  },
  defaultPreload: "intent",
  Wrap: ({ children }: { children: ReactNode }) => (
    <Provider queryClient={queryClient}>{children}</Provider>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
