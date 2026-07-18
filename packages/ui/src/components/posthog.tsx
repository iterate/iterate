// posthog-js only ever runs in the browser; the SSR branch keeps it out of the
// server bundle.
const loadPosthog = import.meta.env.SSR ? null : () => import("posthog-js");

export interface SetupPosthogOptions {
  apiKey?: string;
  proxyUrl?: string;
  uiHost?: string;
  appStage?: string;
  sessionRecording?: boolean;
}

export type PosthogProperties = Record<string, boolean | number | string>;

export interface PosthogPerson {
  distinctId: string;
  properties: PosthogProperties;
}

export interface PosthogGroup {
  type: string;
  key: string;
  properties: PosthogProperties;
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

function buildPosthogInitOptions(options: SetupPosthogOptions) {
  return {
    api_host: resolveBrowserUrl(options.proxyUrl ?? "/api/integrations/posthog/proxy"),
    ui_host: resolveBrowserUrl(options.uiHost ?? "https://eu.posthog.com"),
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
      ? (client: import("posthog-js").PostHogInterface) => {
          client.register({
            $environment: options.appStage,
          });
        }
      : undefined,
  };
}

function setupPosthog(client: import("posthog-js").PostHog, options: SetupPosthogOptions) {
  if (!shouldEnablePosthog(options.apiKey) || typeof window === "undefined") return;

  if (window.__iteratePosthogInitialized && window.__iteratePosthogApiKey === options.apiKey) {
    return;
  }

  client.init(options.apiKey!, buildPosthogInitOptions(options));
  window.__iteratePosthogInitialized = true;
  window.__iteratePosthogApiKey = options.apiKey;
}

let posthogInitStarted = false;
let posthogClientPromise: Promise<import("posthog-js").PostHog> | undefined;
let posthogAppStage: string | undefined;
const registeredContextPropertyNames = new Set<string>();
const identifiedGroupMetadata = new Map<string, string>();

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
  posthogAppStage = options.appStage;
  posthogClientPromise = loadPosthog().then((posthogModule) => {
    setupPosthog(posthogModule.default, options);
    return posthogModule.default;
  });
}

function withPosthogClient(action: (client: import("posthog-js").PostHog) => void) {
  const clientPromise = posthogClientPromise;
  if (!clientPromise) return;
  void clientPromise.then(action);
}

/**
 * Apply the complete authenticated analytics context in one ordered operation.
 * `identify` must precede `group`: posthog-js uses the current person identity
 * when it emits group metadata and attaches group keys to later events.
 */
export function syncPosthogContext(input: {
  eventProperties: PosthogProperties;
  person: PosthogPerson;
  groups: PosthogGroup[];
  resetIdentity?: boolean;
}) {
  withPosthogClient((client) => {
    if (input.resetIdentity) resetPosthogClient(client);
    client.identify(input.person.distinctId, input.person.properties);

    for (const propertyName of registeredContextPropertyNames) {
      if (!Object.hasOwn(input.eventProperties, propertyName)) client.unregister(propertyName);
    }
    if (Object.keys(input.eventProperties).length > 0) client.register(input.eventProperties);
    registeredContextPropertyNames.clear();
    for (const propertyName of Object.keys(input.eventProperties)) {
      registeredContextPropertyNames.add(propertyName);
    }

    client.resetGroups();
    for (const group of input.groups) {
      const metadataKey = JSON.stringify([group.type, group.key]);
      const metadataSignature = JSON.stringify(group.properties);
      const metadata =
        identifiedGroupMetadata.get(metadataKey) === metadataSignature
          ? undefined
          : group.properties;
      client.group(group.type, group.key, metadata);
      identifiedGroupMetadata.set(metadataKey, metadataSignature);
    }
  });
}

/** Reset both the identified person and persistent group keys after sign-out. */
export function resetPosthogIdentity() {
  withPosthogClient(resetPosthogClient);
}

function resetPosthogClient(client: import("posthog-js").PostHog) {
  client.reset();
  registeredContextPropertyNames.clear();
  if (posthogAppStage) client.register({ $environment: posthogAppStage });
}
