import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { PropsWithChildren } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClient } from "@trpc/client";
import type { AppRouter } from "../backend/trpc/root.ts";
import { routeTree } from "./routeTree.gen.ts";
import { makeQueryClient, makeTrpcClient, TRPCProvider } from "./lib/trpc.ts";
import { RootComponent } from "./root-component.tsx";

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
        <div className="flex flex-col items-center justify-center min-h-screen">
          <h1 className="text-2xl font-bold">Page not found</h1>
          <p className="text-muted-foreground">The page you're looking for doesn't exist.</p>
        </div>
      </RootComponent>
    ),
    defaultErrorComponent: ({ error, reset }: { error: Error; reset: () => void }) => (
      <RootComponent>
        <div className="flex flex-col items-center justify-center min-h-screen">
          <h1 className="text-2xl font-bold">{error.name}</h1>
          <p className="text-muted-foreground">{error.message}</p>
          <button
            onClick={() => reset()}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded"
          >
            Reload
          </button>
        </div>
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
