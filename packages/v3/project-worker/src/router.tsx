// router.tsx — the console's router (TanStack Start's default entry: `getRouter` here, the routes in
// src/routes/**, the checked-in tree in routeTree.gen.ts). No query client, no oRPC: every route reads
// through its own server functions.
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type — no explicit return annotation
// (it would reference the tree, which references this function).
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => <p>Not found</p>,
  });
}

// Registers this router app-wide so `<Link to>`, `useNavigate`, `redirect` etc. are typed against
// the generated route tree.
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
