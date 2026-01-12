import { Suspense, type PropsWithChildren, type ReactNode } from "react";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { PostHogProvider as _PostHogProvider } from "posthog-js/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";
import { AppErrorBoundary } from "../components/app-error-boundary.tsx";
import { useRealtimePusher } from "../hooks/use-realtime-pusher.ts";
import type { TanstackRouterContext } from "../router.tsx";

const PostHogProvider =
  import.meta.env.PROD && import.meta.env.VITE_POSTHOG_PUBLIC_KEY
    ? _PostHogProvider
    : ({ children }: PropsWithChildren) => <>{children}</>;

function RouterProgress() {
  const isTransitioning = useRouterState({
    select: (s) => s.isTransitioning,
  });

  if (!isTransitioning) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 h-1 bg-primary/20">
      <div className="h-full bg-primary animate-progress" />
    </div>
  );
}

export const Route = createRootRouteWithContext<TanstackRouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "𝑖" },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico" },
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
      <AppErrorBoundary>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center">
              <div className="text-muted-foreground">Loading...</div>
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </AppErrorBoundary>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <RouterProgress />
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
            {children}
          </PostHogProvider>
          <Toaster />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
