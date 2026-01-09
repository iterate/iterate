import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { Provider } from "./integrations/tanstack-query/root-provider.tsx";
import { getContext } from "./integrations/tanstack-query/trpc-client.ts";

import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const rqContext = getContext();

  const router = createRouter({
    routeTree,
    context: {
      ...rqContext,
    },
    defaultPreload: "intent",
    Wrap: ({ children }) => (
      <Provider queryClient={rqContext.queryClient}>
        {children}
      </Provider>
    ),
  });

  setupRouterSsrQueryIntegration({ router, queryClient: rqContext.queryClient });

  return router;
};
