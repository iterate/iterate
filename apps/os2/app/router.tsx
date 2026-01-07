import { createRouter, Link } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { makeQueryClient, ORPCProvider } from "./lib/orpc.tsx";

export type TanstackRouterContext = {
  queryClient: QueryClient;
};

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">Page Not Found</h1>
      <p className="text-muted-foreground">The page you're looking for doesn't exist.</p>
      <Link to="/" className="text-primary underline">
        Go Home
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
    Wrap: ({ children }) => <ORPCProvider queryClient={queryClient}>{children}</ORPCProvider>,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}
