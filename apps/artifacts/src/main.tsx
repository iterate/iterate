import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen.ts";

// https://tanstack.com/router/latest/docs/framework/react/guide/data-loading
const router = createRouter({
  routeTree,
  defaultPendingMs: 150,
  defaultPendingMinMs: 200,
  defaultStaleTime: 30_000,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
