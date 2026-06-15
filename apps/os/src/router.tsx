import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultNotFoundComponent } from "@iterate-com/ui/components/route-defaults";
import { routeTree } from "./routeTree.gen.ts";

export type { RouterContext } from "./router-context.ts";

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        gcTime: 5 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: 0,
      },
    },
  });

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's
// Register interface, so this function's inferred return type IS the app's
// router type. Two rules keep that inference acyclic:
// - no explicit return/`Router<...>` annotations (they'd reference the tree,
//   which references this function — TS4109/TS7023), and
// - components passed as options are wrapped in lambdas, so checking them
//   doesn't traverse the registered router types.
export function getRouter() {
  const queryClient = makeQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultNotFoundComponent: () => <DefaultNotFoundComponent />,
    // Restore scroll position on back/forward like a regular MPA would:
    // https://tanstack.com/router/latest/docs/framework/react/guide/scroll-restoration
    scrollRestoration: true,
  });

  // Let route loaders and components share the same query client on server and client.
  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}

// Classic router registration for app-wide typed <Link>/useNavigate:
// https://tanstack.com/router/latest/docs/framework/react/guide/creating-a-router#router-type-safety
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
