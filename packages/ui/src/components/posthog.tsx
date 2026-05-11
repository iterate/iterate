import * as PosthogReact from "posthog-js/react";
import posthog, { type PostHog, type PostHogInterface } from "posthog-js";
import { memo, type PropsWithChildren } from "react";

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

// oxlint-disable-next-line react/only-export-components
export function setupPosthog(options: SetupPosthogOptions): PostHog {
  if (!shouldEnablePosthog(options.apiKey) || typeof window === "undefined") return posthog;

  if (window.__iteratePosthogInitialized) {
    if (window.__iteratePosthogApiKey === options.apiKey) {
      return posthog;
    }
  }

  const client = posthog.init(options.apiKey!, buildPosthogInitOptions(options));
  window.__iteratePosthogInitialized = true;
  window.__iteratePosthogApiKey = options.apiKey;
  return client;
}

export const PostHogProvider = memo(
  ({ children, client, enabled }: PropsWithChildren<{ client: PostHog; enabled: boolean }>) =>
    enabled ? (
      <PosthogReact.PostHogProvider client={client}>{children}</PosthogReact.PostHogProvider>
    ) : (
      <>{children}</>
    ),
);
