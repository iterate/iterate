/// <reference types="vite/client" />
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import {
  PostHogProvider,
  setupPosthog,
  shouldEnablePosthog,
} from "@iterate-com/ui/components/posthog";
import { queryClient } from "../router.tsx";
import appCss from "../styles.css?url";

const posthog = setupPosthog({
  apiKey: import.meta.env.VITE_POSTHOG_PUBLIC_KEY,
  proxyUrl: import.meta.env.VITE_POSTHOG_PROXY_URL,
});

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Example" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <PostHogProvider
      client={posthog}
      enabled={shouldEnablePosthog(import.meta.env.VITE_POSTHOG_PUBLIC_KEY)}
    >
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    </PostHogProvider>
  );
}
