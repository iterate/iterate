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

type PostHogInterface = import("posthog-js").PostHogInterface;

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

type PostHog = import("posthog-js").PostHog;

function setupPosthog(client: PostHog, options: SetupPosthogOptions) {
  if (!shouldEnablePosthog(options.apiKey) || typeof window === "undefined") return;

  if (window.__iteratePosthogInitialized && window.__iteratePosthogApiKey === options.apiKey) {
    return;
  }

  client.init(options.apiKey!, buildPosthogInitOptions(options));
  window.__iteratePosthogInitialized = true;
  window.__iteratePosthogApiKey = options.apiKey;
}

let posthogInitStarted = false;

/**
 * Once-per-app-load PostHog initialization. Nothing in our apps reads the
 * PostHog React context, so there is no provider or Effect: autocapture,
 * pageviews, session recording, and exception capture are all configured
 * through `init`. This would run at module scope per React's guidance for app
 * initialization, but the api key only arrives with loader data — so the
 * once-guard lives here at module scope and the first render with config in
 * hand kicks it off. Idempotent, so safe to call during render.
 */
export function initPosthog(options: SetupPosthogOptions) {
  if (posthogInitStarted || !loadPosthog || !shouldEnablePosthog(options.apiKey)) return;
  posthogInitStarted = true;
  void loadPosthog().then((posthogModule) => setupPosthog(posthogModule.default, options));
}
