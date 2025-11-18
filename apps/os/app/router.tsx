import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { routeTree } from "./routeTree.gen";
import { ErrorRenderer } from "./components/error-renderer.tsx";
import { makeQueryClient, makeTrpcClient, TRPCProvider } from "./lib/trpc.ts";
import { RootComponent } from "./root-component.tsx";
import type { PropsWithChildren } from "react";
import type { AppRouter } from "../backend/trpc/root.ts";
import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClient } from "@trpc/client";

export type TanstackRouterContext = {
  trpc: TRPCOptionsProxy<AppRouter>;
  trpcClient: TRPCClient<AppRouter>;
  queryClient: QueryClient;
};

export function getRouter() {
  const queryClient = makeQueryClient();
  const trpcClient = makeTrpcClient();

  const trpc = createTRPCOptionsProxy<AppRouter>({
    client: trpcClient,
    queryClient,
  });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { queryClient, trpc, trpcClient },
    defaultNotFoundComponent: () => (
      <RootComponent>
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
      </RootComponent>
    ),
    defaultErrorComponent: ({ error, info, reset }) => (
      <RootComponent>
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
      </RootComponent>
    ),
    Wrap: function Wrapper({ children }: PropsWithChildren) {
      return (
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          {children}
        </TRPCProvider>
      );
    },
    search: { strict: false },
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}
