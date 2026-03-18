import { createRouter } from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen.ts";
import { makeQueryClient } from "./utils/query.tsx";

export type TanstackRouterContext = {
  queryClient: QueryClient;
};

export function getRouter() {
  const queryClient = makeQueryClient();

  return createRouter({
    routeTree,
    context: { queryClient },
    defaultNotFoundComponent: () => <div>Not Found</div>,
    Wrap({ children }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  });
}
