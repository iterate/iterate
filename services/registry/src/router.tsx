import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";

export const queryClient = new QueryClient();

export interface RouterContext {
  queryClient: QueryClient;
  appCssHrefs: string[];
}

export function createRouter(options?: { appCssHrefs?: string[] }) {
  return createTanStackRouter({
    routeTree,
    context: {
      queryClient,
      appCssHrefs: options?.appCssHrefs ?? [],
    },
    scrollRestoration: true,
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
