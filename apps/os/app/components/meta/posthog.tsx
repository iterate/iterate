import * as PosthogReact from "posthog-js/react";
import posthog from "posthog-js";
import { memo, useEffect, type PropsWithChildren } from "react";
import { useRouter } from "@tanstack/react-router";

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

// oxlint-disable-next-line react/only-export-components
export function setupPosthog() {
  if (!shouldEnablePostHog()) return posthog;
  return posthog.init(import.meta.env.VITE_POSTHOG_PUBLIC_KEY!, {
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

export const PostHogProvider = memo(
  shouldEnablePostHog()
    ? PosthogReact.PostHogProvider
    : ({ children }: PropsWithChildren) => <>{children}</>,
);

// Component that tracks pageviews on navigation
export function PostHogPageviewTracker() {
  const router = useRouter();
  const posthogClient = PosthogReact.usePostHog();

  useEffect(() => {
    if (!posthogClient) return;
    // Capture initial pageview
    posthogClient.capture("$pageview");

    // Subscribe to route changes
    const unsubscribe = router.subscribe("onResolved", () => posthogClient.capture("$pageview"));
    return () => unsubscribe();
  }, [router, posthogClient]);

  return null;
}
