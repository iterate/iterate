/// <reference types="vite/client" />
import { memo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  type ErrorComponentProps,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { Button } from "@iterate-com/ui/components/button";
import {
  PostHogProvider,
  setupPosthog,
  shouldEnablePosthog,
} from "@iterate-com/ui/components/posthog";
import appCss from "../styles.css?url";

export interface RouterContext {
  queryClient: QueryClient;
}

const posthog = setupPosthog({
  apiKey: import.meta.env.VITE_POSTHOG_PUBLIC_KEY,
  proxyUrl: import.meta.env.VITE_POSTHOG_PROXY_URL,
});

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
  errorComponent: RootErrorComponent,
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
  const { queryClient } = Route.useRouteContext();

  return (
    <PostHogProvider
      client={posthog}
      enabled={shouldEnablePosthog(import.meta.env.VITE_POSTHOG_PUBLIC_KEY)}
    >
      <QueryClientProvider client={queryClient}>
        <Outlet />
        <ExampleDevtools />
      </QueryClientProvider>
    </PostHogProvider>
  );
}

const ExampleDevtools = memo(function ExampleDevtools() {
  // Keep devtools app-local and mounted directly under the real router/query
  // providers so the example demonstrates the first-party integration plainly.
  return (
    <TanStackDevtools
      config={{ position: "bottom-right" }}
      plugins={[
        {
          name: "TanStack Router",
          render: <TanStackRouterDevtoolsPanel />,
        },
        {
          name: "TanStack Query",
          render: <ReactQueryDevtoolsPanel />,
        },
      ]}
    />
  );
});

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  // Root route error boundaries are the TanStack Router escape hatch for
  // uncaught loader/render failures, which gives a much cleaner DX than the
  // default uncaught-route warnings:
  // https://tanstack.com/router/v1/docs/api/router/errorComponentComponent
  const message = error instanceof Error ? error.message : "An unexpected error occurred";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={reset}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href="/debug">Go to debug</a>
        </Button>
      </div>
    </div>
  );
}
