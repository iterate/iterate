import {
  Suspense,
  useEffect,
  Component,
  type PropsWithChildren,
  type ReactNode,
  type ErrorInfo,
} from "react";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useRouter,
  useRouterState,
  useHydrated,
} from "@tanstack/react-router";
import {
  PostHogProvider as _PostHogProvider,
  PostHogErrorBoundary as _PostHogErrorBoundary,
  usePostHog,
} from "posthog-js/react";
import posthog from "posthog-js";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";
import { AppErrorFallback } from "../components/app-error-fallback.tsx";
import { useRealtimePusher } from "../hooks/use-realtime-pusher.ts";
import { PostHogIdentityProvider } from "../hooks/posthog-identity-provider.tsx";
import type { TanstackRouterContext } from "../router.tsx";
import { getEnvLogo } from "../lib/env-logo.ts";

// Check if PostHog should be enabled (when key is configured)
const shouldEnablePostHog = () => {
  if (typeof window === "undefined") return false;
  if (!import.meta.env.VITE_POSTHOG_PUBLIC_KEY) return false;
  return true;
};

// Get cross-domain tracking IDs from URL params (from iterate.com)
const getBootstrapConfig = () => {
  if (typeof window === "undefined") return undefined;
  const urlParams = new URLSearchParams(window.location.search);
  const distinctId = urlParams.get("ph_distinct_id");
  const sessionId = urlParams.get("ph_session_id");
  if (!distinctId) return undefined;
  return {
    distinctID: distinctId,
    sessionID: sessionId ?? undefined,
  };
};

// Initialize PostHog client-side with enhanced configuration
if (shouldEnablePostHog()) {
  posthog.init(import.meta.env.VITE_POSTHOG_PUBLIC_KEY!, {
    api_host: import.meta.env.VITE_POSTHOG_PROXY_URL || "/api/integrations/posthog/proxy",
    ui_host: "https://eu.posthog.com",
    // Bootstrap with cross-domain IDs if present (from iterate.com)
    bootstrap: getBootstrapConfig(),
    // Disable automatic pageview - we'll track manually with router
    capture_pageview: false,
    capture_pageleave: true,
    // Exception autocapture - catches unhandled errors and promise rejections
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    // Session replay configuration - mask passwords for security
    session_recording: {
      maskAllInputs: false,
      maskInputOptions: { password: true },
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

// Fallback error boundary for when PostHog is disabled
class FallbackErrorBoundary extends Component<
  PropsWithChildren<{ fallback: ReactNode }>,
  { hasError: boolean }
> {
  constructor(props: PropsWithChildren<{ fallback: ReactNode }>) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error) {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("React error boundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

const PostHogErrorBoundary = shouldEnablePostHog() ? _PostHogErrorBoundary : FallbackErrorBoundary;

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

function RouterProgress() {
  const isTransitioning = useRouterState({
    select: (s) => s.isTransitioning,
  });

  if (!isTransitioning) return null;

  return (
    <div aria-label="Loading" className="fixed top-0 left-0 right-0 z-50 h-1 bg-primary/20">
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
      <PostHogErrorBoundary fallback={<AppErrorFallback />}>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center">
              <div className="text-muted-foreground">Loading...</div>
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </PostHogErrorBoundary>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  const isHydrated = useHydrated();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased" data-hydrated={isHydrated}>
        <RouterProgress />
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
