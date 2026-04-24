import type { QueryClient } from "@tanstack/react-query";
import type { NotFoundRouteProps } from "@tanstack/react-router";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultNotFoundComponent } from "@iterate-com/ui/components/route-defaults";
import { makeQueryClient } from "./orpc/client.ts";
import { routeTree } from "./routeTree.gen.ts";

export type RouterContext = {
  queryClient: QueryClient;
};

// Cast to break circular type reference between DefaultNotFoundComponent's
// props and the router type used in the Register augmentation below.
const notFoundComponent = DefaultNotFoundComponent as (
  props: NotFoundRouteProps,
) => React.ReactNode;

export function getRouter() {
  const queryClient = makeQueryClient();

  const router = createTanStackRouter({
    routeTree,
    context: {
      queryClient,
    } satisfies RouterContext,
    defaultPreload: "intent",
    defaultNotFoundComponent: notFoundComponent,
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

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
