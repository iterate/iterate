import posthog from "posthog-js";
import { PostHogProvider as PHProvider, usePostHog } from "posthog-js/react";
import { Suspense, useEffect, type PropsWithChildren } from "react";
import { useLocation, useSearchParams } from "react-router";

// Check if PostHog should be enabled (only with key configured)
const shouldEnablePostHog = () => {
  if (typeof window === "undefined") return false;
  if (!import.meta.env.VITE_POSTHOG_PUBLIC_KEY) return false;
  return true;
};

// Initialize PostHog client-side only when enabled
if (shouldEnablePostHog()) {
  posthog.init(import.meta.env.VITE_POSTHOG_PUBLIC_KEY!, {
    api_host: import.meta.env.VITE_POSTHOG_PROXY_URL || "/api/integrations/posthog/proxy",
    ui_host: "https://eu.posthog.com",
    capture_pageview: false, // We capture pageviews manually
    capture_pageleave: true, // Enable pageleave capture
    debug: import.meta.env.DEV,
    // Session replay - match apps/os config for consistency
    session_recording: {
      maskAllInputs: false,
      maskInputOptions: { password: true },
      maskTextSelector: "",
    },
    // Register environment as super property (included in all events)
    loaded: (posthog) => {
      posthog.register({
        $environment: import.meta.env.VITE_APP_STAGE,
      });
    },
  });
}

export function PostHogProvider({ children }: PropsWithChildren) {
  if (!shouldEnablePostHog()) {
    return <>{children}</>;
  }

  return (
    <PHProvider client={posthog}>
      <SuspendedPostHogPageView />
      {children}
    </PHProvider>
  );
}

function PostHogPageView() {
  const pathname = useLocation().pathname;
  const [searchParams] = useSearchParams();
  const posthogInstance = usePostHog();

  useEffect(() => {
    if (pathname && posthogInstance) {
      let url = window.origin + pathname;
      const search = searchParams.toString();
      if (search) {
        url += `?${search}`;
      }
      posthogInstance.capture("$pageview", { $current_url: url });
    }
  }, [pathname, searchParams, posthogInstance]);

  return null;
}

function SuspendedPostHogPageView() {
  return (
    <Suspense fallback={null}>
      <PostHogPageView />
    </Suspense>
  );
}
