import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppRouter } from "@iterate-com/ui/apps/router";
import { routeTree } from "./routeTree.gen.ts";

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type.
export function getRouter() {
  // one per router, like the router itself: the server builds one per request
  const queryClient = new QueryClient();
  return createAppRouter({
    routeTree,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
