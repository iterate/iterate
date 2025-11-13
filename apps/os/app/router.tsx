import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCClient } from "@trpc/client";
import { loggerLink, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { PropsWithChildren } from "react";
import type { AppRouter } from "../backend/trpc/root.ts";
import { routeTree } from "./routeTree.gen";
import { ErrorRenderer } from "./components/error-renderer.tsx";
import { getTrpcUrl, makeQueryClient, TRPCProvider } from "./lib/trpc.ts";

export function getRouter() {
  const queryClient = makeQueryClient();

  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      loggerLink({ enabled: () => true }),
      httpBatchLink({
        methodOverride: "POST",
        url: getTrpcUrl(),
      }),
    ],
  });

  const trpc = createTRPCOptionsProxy<AppRouter>({
    client: trpcClient,
    queryClient,
  });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { trpc, trpcClient, queryClient },
    defaultNotFoundComponent: () => (
      <ErrorRenderer
        message="Page not found"
        details="The page you're looking for doesn't exist."
        actions={[
          {
            label: "Refresh",
            action: () => window.location.reload(),
            key: "refresh",
          },
        ]}
      />
    ),
    defaultErrorComponent: ({ error, info, reset }) => (
      <ErrorRenderer
        message={error.name}
        details={error.message}
        stack={info?.componentStack}
        actions={[
          {
            label: "Reload",
            action: () => reset(),
            key: "reload",
          },
        ]}
      />
    ),
    Wrap: function Wrapper({ children }: PropsWithChildren) {
      return (
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          {children}
        </TRPCProvider>
      );
    },
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}
