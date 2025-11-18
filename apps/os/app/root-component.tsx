import { HeadContent, Scripts } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import type { PropsWithChildren } from "react";
import { PostHogProvider as _PostHogProvider } from "posthog-js/react";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { Toaster } from "./components/ui/sonner.tsx";
import appCss from "./app.css?url";

// Fills up the network traffic with useless events in dev
const PostHogProvider =
  import.meta.env.PROD && import.meta.env.VITE_POSTHOG_PUBLIC_KEY
    ? _PostHogProvider
    : ({ children }: PropsWithChildren) => <>{children}</>;

export function RootComponent({ children }: PropsWithChildren) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href={appCss} />
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
              {children}
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
