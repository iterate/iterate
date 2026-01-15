import posthog from "posthog-js";
import { PostHogProvider as PHProvider, usePostHog } from "posthog-js/react";
import { Suspense, useEffect } from "react";
import { useLocation, useSearchParams } from "react-router";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(import.meta.env.VITE_POSTHOG_PUBLIC_KEY, {
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
    });
  }, []);

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
