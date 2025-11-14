import { HeadContent, Scripts, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import type { PropsWithChildren } from "react";
import { PostHogProvider as _PostHogProvider } from "posthog-js/react";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { Toaster } from "../components/ui/sonner.tsx";

import appCss from "../app.css?url";

// Fills up the network traffic with useless events in dev
const PostHogProvider =
  import.meta.env.PROD && import.meta.env.VITE_POSTHOG_PUBLIC_KEY
    ? _PostHogProvider
    : ({ children }: PropsWithChildren) => <>{children}</>;

const sessionLoader = createServerFn().handler(({ context }) => {
  const { session } = context.variables;
  return { session };
});

export const Route = createRootRoute({
  component: RootComponent,
  loader: () => sessionLoader(),
  wrapInSuspense: true,
  head: () => ({
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <HeadContent />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          enableColorScheme
          storageKey="theme"
          disableTransitionOnChange
        >
          <PostHogProvider
            apiKey={import.meta.env.VITE_POSTHOG_PUBLIC_KEY!}
            options={{
              api_host: import.meta.env.VITE_POSTHOG_PROXY_URI,
            }}
          >
            <NuqsAdapter>
              <Outlet />
              <Toaster />
              <Scripts />
              <TanStackDevtools
                plugins={[
                  {
                    name: "TanStack Query",
                    render: <ReactQueryDevtoolsPanel />,
                    defaultOpen: true,
                  },
                  {
                    name: "TanStack Router",
                    render: <TanStackRouterDevtoolsPanel />,
                    defaultOpen: false,
                  },
                ]}
              />
            </NuqsAdapter>
          </PostHogProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
