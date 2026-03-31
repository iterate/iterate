import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { DefaultNotFound } from "./default-not-found.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: DefaultNotFound,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
