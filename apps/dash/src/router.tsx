import { Link } from "@tanstack/react-router";
import { createAppRouter } from "@iterate-com/ui/apps/router";
import { buttonVariants } from "@iterate-com/ui/components/ui/button";
import { DefaultNotFoundComponent } from "@iterate-com/ui/components/route-defaults";
import { routeTree } from "./routeTree.gen.ts";

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type. Components passed as options
// are wrapped in lambdas so checking them doesn't traverse the registered router types (TS7023).
export function getRouter() {
  return createAppRouter({
    routeTree,
    defaultNotFoundComponent: () => (
      <DefaultNotFoundComponent
        action={
          <Link to="/projects" className={buttonVariants({ variant: "outline" })}>
            Back to projects
          </Link>
        }
      />
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
