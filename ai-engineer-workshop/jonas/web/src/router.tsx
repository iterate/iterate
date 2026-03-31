import { Link, createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

function DefaultNotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4">
      <p className="text-lg font-medium text-foreground">Page not found</p>
      <Link to="/" className="text-primary underline underline-offset-4 hover:text-primary/90">
        Go home
      </Link>
    </div>
  );
}

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
