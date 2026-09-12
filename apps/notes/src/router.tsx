import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultErrorComponent: ({ error, reset }) => (
      <main>
        <h1>Could not load Notes</h1>
        <p role="alert">{error.message}</p>
        <button onClick={reset}>Retry</button>
      </main>
    ),
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
