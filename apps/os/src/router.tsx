import { createRouter as createTanStackRouter, type Router } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultNotFoundComponent } from "@iterate-com/ui/components/route-defaults";
import type { QueryClient } from "@tanstack/react-query";
import type { PublicSessionResponse } from "@iterate-com/auth/client";
import { makeQueryClient } from "./orpc/client.ts";
import { routeTree } from "./routeTree.gen.ts";
import type { AppContext } from "./context.ts";

export type RouterContext = {
  queryClient: QueryClient;
  authSession?: PublicSessionResponse;
  currentProjectHostSlug?: string | null;
  iterateAuthIssuer?: string;
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
    // Restore scroll position on back/forward like a regular MPA would:
    // https://tanstack.com/router/latest/docs/framework/react/guide/scroll-restoration
    scrollRestoration: true,
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
