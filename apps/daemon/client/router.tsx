import type { ReactNode } from "react";
import { createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen.ts";
import { orpc } from "./integrations/tanstack-query/trpc-client.tsx";
import { Provider } from "./integrations/tanstack-query/root-provider.tsx";

export interface RouterContext {
  queryClient: QueryClient;
  orpc: typeof orpc;
}

const queryClient = new QueryClient();

// Detect basepath from <base href> tag (injected by proxy) or default to "/"
const getBasepath = (): string => {
  if (typeof document === "undefined") return "/";
  const baseEl = document.querySelector("base");
  if (!baseEl?.href) return "/";
  try {
    const baseUrl = new URL(baseEl.href);
    // Remove trailing slash for consistency with TanStack Router expectations
    return baseUrl.pathname.replace(/\/$/, "") || "/";
  } catch {
    return "/";
  }
};

export const router = createRouter({
  routeTree,
  context: {
    queryClient,
    orpc,
  },
  basepath: getBasepath(),
  defaultPreload: "intent",
  Wrap: ({ children }: { children: ReactNode }) => (
    <Provider queryClient={queryClient}>{children}</Provider>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
