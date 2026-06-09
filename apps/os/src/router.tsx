import { createRouter as createTanStackRouter, type Router } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultNotFoundComponent } from "@iterate-com/ui/components/route-defaults";
import type { QueryClient } from "@tanstack/react-query";
import { makeQueryClient } from "./orpc/client.ts";
import { routeTree } from "./routeTree.gen.ts";
import type { AppContext } from "./context.ts";

export type RouterContext = {
  queryClient: QueryClient;
};

export type AppRouter = Router<typeof routeTree>;

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: AppContext;
    };
  }
}

export function getRouter() {
  const queryClient = makeQueryClient();

  const router: AppRouter = createTanStackRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultNotFoundComponent: DefaultNotFoundComponent,
  });

  // Let route loaders and components share the same query client on server and client.
  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}
