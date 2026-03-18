import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import type { RouterContext } from "./routes/__root.tsx";

export const queryClient = new QueryClient();

export function getRouter() {
  const context: RouterContext = { queryClient };

  const router = createTanStackRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => <p className="p-4 text-muted-foreground">Not found</p>,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
