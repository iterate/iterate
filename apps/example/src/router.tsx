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

// Widen the component type to break a circular reference: the `declare module`
// below resolves `ReturnType<typeof getRouter>`, which expands
// `defaultNotFoundComponent`'s type, which references `RegisteredRouter`,
// which reads `Register.router` — the very thing being defined.
// Events/OS avoid this because their routeTree.gen.ts augments
// `@tanstack/react-start` (under @ts-nocheck) instead of `@tanstack/react-router`.
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
