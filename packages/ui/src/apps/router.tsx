import {
  createRouter,
  type AnyRoute,
  type RouterConstructorOptions,
  type RouterHistory,
} from "@tanstack/react-router";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
  DefaultPendingComponent,
} from "../components/route-defaults.tsx";

/** Every app's router (its src/router.tsx `getRouter`): TanStack's `createRouter` with the defaults
 *  every app shares; an app's own options win. */
export function createAppRouter<TRouteTree extends AnyRoute>(
  options: RouterConstructorOptions<TRouteTree, "never", false, RouterHistory, Record<string, any>>,
) {
  return createRouter<TRouteTree>({
    defaultPreload: "intent",
    scrollRestoration: true,
    // Components passed as options are wrapped in lambdas so checking them doesn't traverse the
    // registered router types (TS7023).
    defaultErrorComponent: (props) => <DefaultErrorComponent {...props} />,
    defaultNotFoundComponent: () => <DefaultNotFoundComponent />,
    // Without a default pending component, an `ssr: false` route — the whole signed-in `_auth`
    // layout — renders a BLANK outlet in the SSR shell and again while `beforeLoad`/`loader` run on
    // the client. Blank is bad UX and breaks the "the app always reports progress" contract the
    // specs enforce (their spinner-waiter only extends waits while a spinner is visible).
    defaultPendingComponent: () => <DefaultPendingComponent />,
    // Show that feedback quickly on client-side loads too: the library defaults (1000ms before
    // pending shows, 500ms minimum once shown) leave a full second of blank panel before any
    // signal appears.
    defaultPendingMs: 300,
    defaultPendingMinMs: 200,
    ...options,
  });
}
