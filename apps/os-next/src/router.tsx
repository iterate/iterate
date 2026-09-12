// The issuer and console share this router; authenticated routes use public RPC.
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

// routeTree.gen.ts registers `router: ReturnType<typeof getRouter>` on Start's Register interface,
// so this function's inferred return type IS the app's router type — no explicit return annotation
// (it would reference the tree, which references this function).
export function getRouter() {
  return createRouter({
    routeTree,
    // OAuth uses form-encoded strings and repeated keys. Start canonicalizes URLs
    // on the server too, so its default JSON search codec would corrupt resources.
    parseSearch: (search) => {
      const params = new URLSearchParams(search);
      return Object.fromEntries(
        [...params.keys()].map((key) => {
          const values = params.getAll(key);
          return [key, values.length === 1 ? values[0] : values];
        }),
      );
    },
    stringifySearch: (search) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(search))
        for (const entry of [value].flat())
          if (entry !== undefined) params.append(key, String(entry));
      const query = params.toString();
      return query ? `?${query}` : "";
    },
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
