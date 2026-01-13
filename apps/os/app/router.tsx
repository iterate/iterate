import { createRouter, Link, type ErrorComponentProps } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { makeQueryClient, TRPCProvider } from "./lib/trpc.tsx";
import { Spinner } from "./components/ui/spinner.tsx";

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

function DefaultPendingComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="size-8" />
    </div>
  );
}

function DefaultErrorComponent({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-muted-foreground max-w-md text-center">
        {error instanceof Error ? error.message : "An unexpected error occurred"}
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try again
        </button>
        <Link to="/" className="text-primary hover:underline self-center">
          Go home
        </Link>
      </div>
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
    defaultPendingMs: 150,
    defaultPendingMinMs: 200,
    defaultPendingComponent: DefaultPendingComponent,
    defaultErrorComponent: DefaultErrorComponent,
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
