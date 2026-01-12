import type { ReactNode } from "react";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { Provider } from "./integrations/tanstack-query/root-provider.tsx";
import { getContext } from "./integrations/tanstack-query/trpc-client.ts";
import { getBasePathFromDocument } from "./base-path.ts";

import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const rqContext = getContext();

  // Get base path from <base> element if running in browser
  // This allows the daemon to work behind a reverse proxy with path prefixing
  const basePath = getBasePathFromDocument();

  const router = createRouter({
    routeTree,
    basepath: basePath === "/" ? undefined : basePath,
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
