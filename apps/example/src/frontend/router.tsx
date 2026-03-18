import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import type { RouterContext } from "./routes/__root.tsx";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(error, query) {
      // QueryCache global callbacks run once per failing query, which keeps this
      // browser signal much less noisy than per-observer handlers:
      // https://tanstack.com/query/latest/docs/reference/QueryCache?from=reactQueryV3
      console.error("[example.query:error]", {
        queryKey: query.queryKey,
        error,
      });
    },
  }),
  mutationCache: new MutationCache({
    onError(error, variables, _onMutateResult, mutation) {
      // Same idea as the query hook above: log once per failed mutation at the
      // cache boundary instead of duplicating error handlers at each observer.
      // https://tanstack.com/query/latest/docs/reference/MutationCache
      console.error("[example.mutation:error]", {
        mutationKey: mutation.options.mutationKey,
        variables,
        error,
      });
    },
  }),
});

export function getRouter() {
  const context: RouterContext = { queryClient };

  const router = createTanStackRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => <p className="p-4 text-muted-foreground">Not found</p>,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
