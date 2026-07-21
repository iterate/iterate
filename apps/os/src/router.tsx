import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { DefaultNotFoundComponent } from "@iterate-com/ui/components/route-defaults";
import { capturePosthogException } from "@iterate-com/ui/components/posthog";
import { createIterateQueryClient } from "iterate/sdk/itx/react";
import { RoutePending } from "./components/route-pending.tsx";
import { routeTree } from "./routeTree.gen.ts";

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's
// Register interface, so this function's inferred return type IS the app's
// router type. Two rules keep that inference acyclic:
// - no explicit return/`Router<...>` annotations (they'd reference the tree,
//   which references this function — TS4109/TS7023), and
// - components passed as options are wrapped in lambdas, so checking them
//   doesn't traverse the registered router types.
export function getRouter() {
  const queryClient = createIterateQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultNotFoundComponent: () => <DefaultNotFoundComponent />,
    // TanStack catches at the nearest route match; the router default is the
    // app-wide hook (a root-route onCatch would miss child route failures).
    defaultOnCatch: capturePosthogException,
    // Without a default pending component, an `ssr: false` route leaf renders a
    // BLANK outlet in the SSR shell and again while `beforeLoad`/`loader` run on
    // the client. Blank is bad UX and
    // breaks the "the app always reports progress" contract the e2e specs
    // enforce (their spinner-waiter only extends waits while a spinner is
    // visible; docs/preview-e2e-flake-hunt.md flake 21).
    defaultPendingComponent: () => <RoutePending />,
    // Show that feedback quickly on client-side loads too: the library
    // defaults (1000ms before pending shows, 500ms minimum once shown) leave a
    // full second of blank panel before any signal appears.
    defaultPendingMs: 300,
    defaultPendingMinMs: 200,
    // Restore scroll position on back/forward like a regular MPA would:
    // https://tanstack.com/router/latest/docs/framework/react/guide/scroll-restoration
    // …EXCEPT on stream feed pages. Restoration records every scrolled
    // element by CSS path and re-applies the saved position on render — on a
    // chat-style feed that races the feed's own open-at-latest end pin and
    // can strand the viewport mid-history. Chat feeds open at the newest
    // message, always (there is no per-element opt-out, so the whole
    // location opts out; nothing else on those pages needs restoring).
    scrollRestoration: ({ location }) => !location.pathname.includes("/streams"),
  });

  // Let route loaders and components share the same query client on server and client.
  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}

// Classic router registration for app-wide typed <Link>/useNavigate:
// https://tanstack.com/router/latest/docs/framework/react/guide/creating-a-router#router-type-safety
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
