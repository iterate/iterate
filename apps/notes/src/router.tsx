import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "@iterate-com/ui/components/route-defaults";
import { basePathOf, basePathRewrite, documentBasePath } from "./base-path.ts";
import { routeTree } from "./routeTree.gen.ts";

/** The base path this page is served under (base-path.ts): the request's in the server render,
 *  the document's in the browser. */
const basePath = createIsomorphicFn()
  .server(() => basePathOf(getRequest().headers))
  .client(() => documentBasePath());

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type. Components passed as options
// are wrapped in lambdas so checking them doesn't traverse the registered router types (TS7023).
export function getRouter() {
  const base = basePath();
  return createRouter({
    routeTree,
    context: { basePath: base },
    rewrite: basePathRewrite(base),
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultErrorComponent: (props) => <DefaultErrorComponent {...props} />,
    defaultNotFoundComponent: () => <DefaultNotFoundComponent />,
    // Without a default pending component, an `ssr: false` route — here the whole signed-in
    // `_auth` layout — renders a BLANK outlet in the SSR shell and again while
    // `beforeLoad`/`loader` run on the client. Blank is bad UX and breaks the "the app always
    // reports progress" contract the e2e specs enforce (their spinner-waiter only extends waits
    // while a spinner is visible).
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
}
