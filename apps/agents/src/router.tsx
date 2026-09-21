import { createRouter } from "@tanstack/react-router";
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
    // Restore scroll position on back/forward like a regular MPA would:
    // https://tanstack.com/router/latest/docs/framework/react/guide/scroll-restoration
    // …EXCEPT on the agent chat pages (/projects/<slug>). Restoration records every scrolled
    // element by CSS path and re-applies the saved position on render — on a chat-style feed that
    // races the feed's own open-at-latest end pin (the shared Conversation's StickToBottom) and
    // can strand the viewport mid-history. Chat feeds open at the newest message, always (there is
    // no per-element opt-out, so the whole location opts out; nothing else on those pages needs
    // restoring).
    scrollRestoration: ({ location }) => !location.pathname.startsWith("/projects/"),
    defaultErrorComponent: (props) => <DefaultErrorComponent {...props} />,
    defaultNotFoundComponent: () => <DefaultNotFoundComponent />,
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
}
