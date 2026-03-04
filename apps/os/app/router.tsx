import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { QueryClient } from "@tanstack/react-query";
import type { PostHog } from "posthog-js";
import { routeTree } from "./routeTree.gen";
import { makeQueryClient } from "./lib/orpc.tsx";
import {
  DefaultErrorComponent,
  DefaultPendingComponent,
  DefaultNotFoundComponent,
} from "./components/meta/defaults.tsx";
import { setupPosthog } from "./components/meta/posthog.tsx";

export type TanstackRouterContext = {
  queryClient: QueryClient;
  posthog: PostHog;
};

export function getRouter() {
  const queryClient = makeQueryClient();
  const posthog = setupPosthog();

  const router = createRouter({
    routeTree,
    context: { queryClient, posthog },
    scrollRestoration: true,
    defaultPendingMs: 150,
    defaultPendingMinMs: 200,
    defaultPendingComponent: DefaultPendingComponent,
    defaultNotFoundComponent: DefaultNotFoundComponent,
    defaultErrorComponent: DefaultErrorComponent,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}
