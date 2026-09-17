import { createRouter, Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import { routeTree } from "./routeTree.gen.ts";
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultErrorComponent: ({ error, reset }) => (
      <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
        <h1 className="text-xl font-semibold">Could not load the dash</h1>
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
        <div>
          <Button onClick={reset}>Retry</Button>
        </div>
      </main>
    ),
    defaultNotFoundComponent: () => (
      <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
        <h1 className="text-xl font-semibold">Not found</h1>
        <p className="text-sm text-muted-foreground">
          Nothing lives at this address, or this session does not reach it.
        </p>
        <div>
          <Link to="/projects" className={buttonVariants({ variant: "outline" })}>
            Back to projects
          </Link>
        </div>
      </main>
    ),
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
  /** A page outside /projects names itself for the shell's breadcrumb (`staticData: { page }`). */
  interface StaticDataRouteOption {
    page?: string;
  }
}
