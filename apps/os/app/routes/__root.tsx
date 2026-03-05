import type { PropsWithChildren } from "react";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useHydrated,
} from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { useRealtimePusher } from "@/hooks/use-realtime-pusher.ts";
import { PostHogIdentityProvider } from "@/hooks/posthog-identity-provider.tsx";
import type { TanstackRouterContext } from "@/router.tsx";
import { getEnvLogo } from "@/lib/env-logo.ts";
import { PostHogPageviewTracker, PostHogProvider } from "@/components/meta/posthog.tsx";
import { Devtools } from "@/components/meta/devtools.tsx";
import appCss from "@/styles.css?url";

export const Route = createRootRouteWithContext<TanstackRouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "𝑖" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: getEnvLogo() },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
  wrapInSuspense: true,
});

function RootComponent() {
  useRealtimePusher();

  return (
    <RootDocument>
      <Outlet />
      <Toaster />
      <PostHogPageviewTracker />
      <Devtools />
    </RootDocument>
  );
}

function RootDocument({ children }: PropsWithChildren) {
  const { posthog } = Route.useRouteContext();
  const isHydrated = useHydrated();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased" data-hydrated={isHydrated}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          enableColorScheme
          storageKey="theme"
          disableTransitionOnChange
        >
          <PostHogProvider client={posthog}>
            <PostHogIdentityProvider>{children}</PostHogIdentityProvider>
          </PostHogProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
