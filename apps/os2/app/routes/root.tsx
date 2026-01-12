import { Suspense, useEffect, type PropsWithChildren, type ReactNode } from "react";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { PostHogProvider as _PostHogProvider, usePostHog } from "posthog-js/react";
import posthog from "posthog-js";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";
import { AppErrorBoundary } from "../components/app-error-boundary.tsx";
import { useRealtimePusher } from "../hooks/use-realtime-pusher.ts";
import { PostHogIdentityProvider } from "../hooks/posthog-identity-provider.tsx";
import type { TanstackRouterContext } from "../router.tsx";

// Check if PostHog should be enabled (only in production with key)
const shouldEnablePostHog = () => {
  if (typeof window === "undefined") return false;
  if (!import.meta.env.PROD) return false;
  if (!import.meta.env.VITE_POSTHOG_PUBLIC_KEY) return false;
  return true;
};

// Initialize PostHog client-side with enhanced configuration
if (shouldEnablePostHog()) {
  posthog.init(import.meta.env.VITE_POSTHOG_PUBLIC_KEY!, {
    api_host: import.meta.env.VITE_POSTHOG_PROXY_URI || "/ingest",
    ui_host: "https://eu.posthog.com",
    // Disable automatic pageview - we'll track manually with router
    capture_pageview: false,
    capture_pageleave: true,
    // Session replay configuration (no masking per requirements)
    session_recording: {
      maskAllInputs: false,
      maskTextSelector: "",
    },
    // Register environment as super property
    loaded: (posthog) => {
      posthog.register({
        $environment: import.meta.env.VITE_APP_STAGE,
      });
    },
  });
}

const PostHogProvider = shouldEnablePostHog()
  ? _PostHogProvider
  : ({ children }: PropsWithChildren) => <>{children}</>;

// Component that tracks pageviews on navigation
function PostHogPageviewTracker() {
  const router = useRouter();
  const posthogClient = usePostHog();

  useEffect(() => {
    if (!posthogClient) return;

    // Capture initial pageview
    posthogClient.capture("$pageview");

    // Subscribe to route changes
    const unsubscribe = router.subscribe("onResolved", () => {
      posthogClient.capture("$pageview");
    });

    return () => {
      unsubscribe();
    };
  }, [router, posthogClient]);

  return null;
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
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          enableColorScheme
          storageKey="theme"
          disableTransitionOnChange
        >
          <PostHogProvider client={posthog}>
            <PostHogIdentityProvider>
              <PostHogPageviewTracker />
              {children}
            </PostHogIdentityProvider>
          </PostHogProvider>
          <Toaster />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
