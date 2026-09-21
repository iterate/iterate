import { createRouter, Link } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "@iterate-com/ui/components/route-defaults";
import { routeTree } from "./routeTree.gen.ts";

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type. Components passed as options
// are wrapped in lambdas so checking them doesn't traverse the registered router types (TS7023).
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultErrorComponent: (props) => <DefaultErrorComponent {...props} />,
    defaultNotFoundComponent: () => (
      <DefaultNotFoundComponent
        action={
          <Link to="/projects" className={buttonVariants({ variant: "outline" })}>
            Back to projects
          </Link>
        }
      />
    ),
    // Without a default pending component, an `ssr: false` route — here the whole signed-in
    // `_auth` layout — renders a BLANK outlet in the SSR shell and again while
    // `beforeLoad`/`loader` run on the client. Blank is bad UX and breaks the "the app always
    // reports progress" contract the e2e specs enforce (their spinner-waiter only extends waits
    // while a spinner is visible; docs/preview-e2e-flake-hunt.md flake 21).
    defaultPendingComponent: () => <DefaultPendingComponent />,
    // Show that feedback quickly on client-side loads too: the library defaults (1000ms before
    // pending shows, 500ms minimum once shown) leave a full second of blank panel before any
    // signal appears.
    defaultPendingMs: 300,
    defaultPendingMinMs: 200,
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
