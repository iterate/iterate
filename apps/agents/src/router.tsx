import { createAppRouter } from "@iterate-com/ui/apps/router";
import { routeTree } from "./routeTree.gen.ts";

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type.
export function getRouter() {
  return createAppRouter({
    routeTree,
    // Restore scroll position on back/forward like a regular MPA would:
    // https://tanstack.com/router/latest/docs/framework/react/guide/scroll-restoration
    // …EXCEPT on the agent chat pages (/projects/<slug>). Restoration records every scrolled
    // element by CSS path and re-applies the saved position on render — on a chat-style feed that
    // races the feed's own open-at-latest end pin (the shared Conversation's StickToBottom) and
    // can strand the viewport mid-history. Chat feeds open at the newest message, always (there is
    // no per-element opt-out, so the whole location opts out; nothing else on those pages needs
    // restoring).
    scrollRestoration: ({ location }) => !location.pathname.startsWith("/projects/"),
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
