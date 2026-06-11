import { memo, useEffect, useState, type ComponentType, type PropsWithChildren } from "react";

type PostHog = import("posthog-js").PostHog;
type PostHogInterface = import("posthog-js").PostHogInterface;
type PostHogProviderComponent = ComponentType<PropsWithChildren<{ client: PostHog }>>;
const loadPostHogModules = import.meta.env.SSR
  ? null
  : async () => Promise.all([import("posthog-js/react"), import("posthog-js")]);

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

function setupPosthog(client: PostHog, options: SetupPosthogOptions): PostHog {
  if (!shouldEnablePosthog(options.apiKey) || typeof window === "undefined") return client;

  if (window.__iteratePosthogInitialized) {
    if (window.__iteratePosthogApiKey === options.apiKey) {
      return client;
    }
  }

  const initialized = client.init(options.apiKey!, buildPosthogInitOptions(options));
  window.__iteratePosthogInitialized = true;
  window.__iteratePosthogApiKey = options.apiKey;
  return initialized;
}

export const PostHogProvider = memo(
  ({
    children,
    enabled,
    options,
  }: PropsWithChildren<{ enabled: boolean; options: SetupPosthogOptions }>) => {
    const { apiKey, appStage, bootstrapFromUrl, proxyUrl, sessionRecording, uiHost } = options;
    const [provider, setProvider] = useState<{
      ClientProvider: PostHogProviderComponent;
      client: PostHog;
    } | null>(null);

    useEffect(() => {
      const loader = loadPostHogModules;
      if (!enabled || !shouldEnablePosthog(apiKey) || !loader) {
        setProvider(null);
        return;
      }

      setProvider(null);
      let disposed = false;

      async function loadPosthog() {
        const [{ PostHogProvider: ClientProvider }, posthogModule] = await loader!();
        if (disposed) return;
        setProvider({
          ClientProvider,
          client: setupPosthog(posthogModule.default, {
            apiKey,
            appStage,
            bootstrapFromUrl,
            proxyUrl,
            sessionRecording,
            uiHost,
          }),
        });
      }

      void loadPosthog();

      return () => {
        disposed = true;
      };
    }, [apiKey, appStage, bootstrapFromUrl, enabled, proxyUrl, sessionRecording, uiHost]);

    if (!enabled || !provider) return <>{children}</>;

    return <provider.ClientProvider client={provider.client}>{children}</provider.ClientProvider>;
  },
);
