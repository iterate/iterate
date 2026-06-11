import { useEffect } from "react";

type PostHog = import("posthog-js").PostHog;
type PostHogInterface = import("posthog-js").PostHogInterface;

// posthog-js only ever runs in the browser; the SSR branch keeps it out of the
// server bundle.
const loadPosthog = import.meta.env.SSR ? null : () => import("posthog-js");

export interface SetupPosthogOptions {
  apiKey?: string;
  proxyUrl?: string;
  uiHost?: string;
  appStage?: string;
  bootstrapFromUrl?: boolean;
  sessionRecording?: boolean;
}

declare global {
  interface Window {
    __iteratePosthogInitialized?: boolean;
    __iteratePosthogApiKey?: string;
  }
}

export function shouldEnablePosthog(apiKey?: string) {
  return Boolean(apiKey);
}

function resolveBrowserUrl(url?: string) {
  if (!url) return undefined;
  if (typeof window === "undefined") return url;

  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

function getBootstrapConfig() {
  if (typeof window === "undefined") return undefined;
  const urlParams = new URLSearchParams(window.location.search);
  const distinctId = urlParams.get("ph_distinct_id");
  const sessionId = urlParams.get("ph_session_id");
  if (!distinctId) return undefined;
  return {
    distinctID: distinctId,
    sessionID: sessionId ?? undefined,
  };
}

function buildPosthogInitOptions(options: SetupPosthogOptions) {
  return {
    api_host: resolveBrowserUrl(options.proxyUrl ?? "/api/integrations/posthog/proxy"),
    ui_host: resolveBrowserUrl(options.uiHost ?? "https://eu.posthog.com"),
    bootstrap: options.bootstrapFromUrl ? getBootstrapConfig() : undefined,
    defaults: "2026-01-30" as const,
    capture_pageleave: true,
    capture_exceptions: true,
    ...(options.sessionRecording === false
      ? {}
      : {
          session_recording: {
            maskAllInputs: true,
            maskTextSelector: "*",
          },
        }),
    loaded: options.appStage
      ? (client: PostHogInterface) => {
          client.register({
            $environment: options.appStage,
          });
        }
      : undefined,
  };
}

function setupPosthog(client: PostHog, options: SetupPosthogOptions) {
  if (!shouldEnablePosthog(options.apiKey) || typeof window === "undefined") return;

  if (window.__iteratePosthogInitialized && window.__iteratePosthogApiKey === options.apiKey) {
    return;
  }

  client.init(options.apiKey!, buildPosthogInitOptions(options));
  window.__iteratePosthogInitialized = true;
  window.__iteratePosthogApiKey = options.apiKey;
}

/**
 * Initializes PostHog as a browser-only side effect. Nothing in our apps reads
 * the PostHog React context, so there is no provider: autocapture, pageviews,
 * session recording, and exception capture are all configured through `init`.
 */
export function PostHogInit({
  enabled,
  options,
}: {
  enabled: boolean;
  options: SetupPosthogOptions;
}) {
  const { apiKey, appStage, bootstrapFromUrl, proxyUrl, sessionRecording, uiHost } = options;

  useEffect(() => {
    if (!enabled || !shouldEnablePosthog(apiKey) || !loadPosthog) return;
    void loadPosthog().then((posthogModule) =>
      setupPosthog(posthogModule.default, {
        apiKey,
        appStage,
        bootstrapFromUrl,
        proxyUrl,
        sessionRecording,
        uiHost,
      }),
    );
  }, [apiKey, appStage, bootstrapFromUrl, enabled, proxyUrl, sessionRecording, uiHost]);

  return null;
}
