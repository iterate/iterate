import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
} from "@iterate-com/ui/components/route-defaults";
import { routeTree } from "./routeTree.gen.ts";
import { makeQueryClient } from "./utils/query.tsx";

export type TanstackRouterContext = {
  queryClient: QueryClient;
};

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's
// Register interface, so this function's inferred return type IS the app's
// router type. Two rules keep that inference acyclic (see
// apps/os/docs/simplification-decisions.md §5):
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
    // Restore scroll position on back/forward like a regular MPA would:
    // https://tanstack.com/router/latest/docs/framework/react/guide/scroll-restoration
    scrollRestoration: true,
    defaultErrorComponent: (props) => <DefaultErrorComponent {...props} />,
    defaultNotFoundComponent: () => <DefaultNotFoundComponent />,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}

// Registers this router app-wide so `<Link to>`, `useNavigate`, `redirect`
// etc. are typed against the generated route tree.
// https://tanstack.com/router/latest/docs/framework/react/guide/type-safety
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
