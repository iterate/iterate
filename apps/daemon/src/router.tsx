import type { ReactNode } from "react";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { Provider } from "./integrations/tanstack-query/root-provider.tsx";
import { getContext } from "./integrations/tanstack-query/trpc-client.ts";

import { routeTree } from "./routeTree.gen";

// Get base path from proxy injection (if running behind proxy)
function getBasePath(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const proxyBase = (window as { __PROXY_BASE_PATH__?: string }).__PROXY_BASE_PATH__;
  return proxyBase || undefined;
}

export const getRouter = () => {
  const rqContext = getContext();
  const basePath = getBasePath();

  const router = createRouter({
    routeTree,
    basepath: basePath,
    context: {
      ...rqContext,
    },
    defaultPreload: "intent",
    Wrap: ({ children }: { children: ReactNode }) => (
      <Provider queryClient={rqContext.queryClient}>{children}</Provider>
    ),
  });

  setupRouterSsrQueryIntegration({ router, queryClient: rqContext.queryClient });

  return router;
};
