import { shouldSendPosthogEvents } from "@iterate-com/shared/posthog";

// posthog-js only ever runs in the browser; the SSR branch keeps it out of the
// server bundle.
const loadPosthog = import.meta.env.SSR ? null : () => import("posthog-js");

export interface SetupPosthogOptions {
  apiKey?: string;
  proxyUrl?: string;
  uiHost?: string;
  appStage?: string;
  capturePageviews?: boolean;
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

export interface PosthogContext {
  person: PosthogPerson;
  groups: PosthogGroup[];
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
  // Non-production deployments still initialize the SDK (feature flags,
  // toolbar) but never send events: `before_send` drops everything at egress,
  // and session recording is off since its $snapshot events would be dropped
  // anyway. appStage is the deployed worker name; local dev has none.
  const sendEvents = shouldSendPosthogEvents(options.appStage);
  const sessionRecording = options.sessionRecording !== false && sendEvents;
  return {
    ...(!sendEvents && { before_send: () => null }),
    api_host: resolveBrowserUrl(options.proxyUrl ?? "/e"),
    ui_host: resolveBrowserUrl(options.uiHost ?? "https://eu.posthog.com"),
    defaults: "2026-06-25" as const,
    person_profiles: "identified_only" as const,
    capture_pageview: options.capturePageviews === false ? false : ("history_change" as const),
    capture_pageleave: true,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    disable_session_recording: !sessionRecording,
    disable_capture_url_hashes: true,
    mask_all_element_attributes: true,
    mask_all_text: true,
    strict_script_versioning: true,
    ...(sessionRecording && {
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        recordBody: false,
        recordHeaders: false,
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
let appliedContextSignature: string | undefined;
let identifiedPersonSignature: string | undefined;
const identifiedGroupMetadata = new Map<string, string>();

/**
 * Once-per-app-load PostHog initialization. Nothing in our apps reads the
 * PostHog React context, so there is no provider: autocapture, session replay,
 * feature flags, surveys, and exception capture all run through `init`. This
 * would run at module scope per React's guidance for app
 * initialization, but the api key only arrives with loader data — so the
 * once-guard lives here at module scope and the first render with config in
 * hand kicks it off. Idempotent, so safe to call during render.
 */
export function initPosthog(options: SetupPosthogOptions) {
  if (posthogInitStarted || !loadPosthog || !shouldEnablePosthog(options.apiKey)) return;
  posthogInitStarted = true;
  posthogAppStage = options.appStage;
  const clientPromise = loadPosthog().then((posthogModule) => {
    setupPosthog(posthogModule.default, options);
    return posthogModule.default;
  });
  posthogClientPromise = clientPromise;
  void clientPromise.catch((error: unknown) => {
    if (posthogClientPromise === clientPromise) {
      posthogInitStarted = false;
      posthogClientPromise = undefined;
    }
    console.error("PostHog browser SDK failed to load", error);
  });
}

function withPosthogClient(action: (client: import("posthog-js").PostHog) => void) {
  const clientPromise = posthogClientPromise;
  if (!clientPromise) return;
  void clientPromise.then(action, () => undefined);
}

/** Synchronize identity and groups without recording a navigation. */
export function syncPosthogContext(input: PosthogContext | null) {
  withPosthogClient((client) => applyPosthogContext(client, input));
}

/** Apply identity/groups, then capture the resolved TanStack location. */
export function capturePosthogPageview(input: PosthogContext | null, href?: string) {
  withPosthogClient((client) => {
    applyPosthogContext(client, input);
    const currentUrl = resolveBrowserUrl(href);
    client.capture("$pageview", currentUrl ? { $current_url: currentUrl } : undefined);
  });
}

/** Capture errors handled by framework error boundaries. */
export function capturePosthogException(error: unknown) {
  withPosthogClient((client) => client.captureException(error));
}

function applyPosthogContext(client: import("posthog-js").PostHog, input: PosthogContext | null) {
  const signature = JSON.stringify(input);
  if (signature === appliedContextSignature) return;

  if (!input) {
    if (
      typeof client.get_property("$user_id") === "string" ||
      Object.keys(client.getGroups()).length > 0
    ) {
      resetPosthogClient(client);
    }
    appliedContextSignature = signature;
    return;
  }

  const personSignature = JSON.stringify(input.person);
  const currentUserId = client.get_property("$user_id");
  if (typeof currentUserId === "string" && currentUserId !== input.person.distinctId) {
    resetPosthogClient(client);
  }
  if (identifiedPersonSignature !== personSignature) {
    client.identify(input.person.distinctId, input.person.properties);
    identifiedPersonSignature = personSignature;
  }

  const desiredGroupTypes = new Set(input.groups.map((group) => group.type));
  let currentGroups = client.getGroups();
  if (Object.keys(currentGroups).some((type) => !desiredGroupTypes.has(type))) {
    client.resetGroups();
    currentGroups = {};
  }
  for (const group of input.groups) {
    const metadataSignature = JSON.stringify([group.key, group.properties]);
    const metadataChanged = identifiedGroupMetadata.get(group.type) !== metadataSignature;
    if (currentGroups[group.type] !== group.key || metadataChanged) {
      client.group(group.type, group.key, metadataChanged ? group.properties : undefined);
    }
    identifiedGroupMetadata.set(group.type, metadataSignature);
  }
  for (const type of identifiedGroupMetadata.keys()) {
    if (!desiredGroupTypes.has(type)) identifiedGroupMetadata.delete(type);
  }
  appliedContextSignature = signature;
}

function resetPosthogClient(client: import("posthog-js").PostHog) {
  client.reset();
  appliedContextSignature = undefined;
  identifiedPersonSignature = undefined;
  identifiedGroupMetadata.clear();
  if (posthogAppStage) client.register({ $environment: posthogAppStage });
}
