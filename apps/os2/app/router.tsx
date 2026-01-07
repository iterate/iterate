import { createRouter, Link } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { makeQueryClient, TRPCProvider } from "./lib/trpc.tsx";

/* eslint-disable react-refresh/only-export-components -- not sure if this is actually bad */

export type TanstackRouterContext = {
  queryClient: QueryClient;
};

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-muted-foreground">The page you're looking for doesn't exist.</p>
      <Link to="/" className="text-primary hover:underline">
        Go home
      </Link>
    </div>
  );
}

export function getRouter() {
  const queryClient = makeQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    search: { strict: false },
    defaultNotFoundComponent: NotFoundComponent,
    Wrap: ({ children }) => <TRPCProvider queryClient={queryClient}>{children}</TRPCProvider>,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}
