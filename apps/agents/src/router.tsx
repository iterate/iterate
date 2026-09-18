import { createRouter } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { routeTree } from "./routeTree.gen.ts";
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultErrorComponent: ({ error, reset }) => (
      <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
        <h1 className="text-xl font-semibold">Could not load Agents</h1>
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
        <div>
          <Button onClick={reset}>Retry</Button>
        </div>
      </main>
    ),
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
