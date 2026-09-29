import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createAppRouter } from "@iterate-com/ui/apps/router";
import { basePathOf, basePathRewrite, documentBasePath } from "@iterate-com/ui/apps/base-path";
import { routeTree } from "./routeTree.gen.ts";

/** The base path this page is served under (@iterate-com/ui/apps/base-path): the request's in the
 *  server render, the document's in the browser. */
const basePath = createIsomorphicFn()
  .server(() => basePathOf(getRequest().headers))
  .client(() => documentBasePath());

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type.
export function getRouter() {
  const base = basePath();
  // one per router, like the router itself: the server builds one per request
  const queryClient = new QueryClient();
  return createAppRouter({
    routeTree,
    context: { basePath: base },
    rewrite: basePathRewrite(base),
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
