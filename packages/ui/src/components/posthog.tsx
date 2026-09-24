import { useEffect } from "react";
import { sessionRecordingPrivacy } from "./not-recorded.tsx";

// posthog-js only ever runs in the browser; the SSR branch keeps it out of the
// server bundle.
const loadPosthog = import.meta.env.SSR ? null : () => import("posthog-js");

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

// Only a deployment that should report is given a key (envs.ts: prd), so an initialized SDK sends.
// Replays record what people type, except secrets (`sessionRecordingPrivacy`, not-recorded.tsx): a
// password replays as `***`, and a secret field (`SecretInput`, `SecretTextarea`) or a secret on
// screen (`NotRecorded`) is not recorded at all. `api_host` is this app's own `/e` proxy
// (proxyPosthogRequest in @iterate-com/shared/posthog), resolved against the page's origin.
export function posthogInitOptions() {
  return {
    api_host: new URL("/e", window.location.origin).toString(),
    ui_host: "https://eu.posthog.com",
    defaults: "2026-06-25" as const,
    person_profiles: "identified_only" as const,
    capture_pageview: "history_change" as const,
    capture_pageleave: true,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    disable_session_recording: false,
    disable_capture_url_hashes: true,
    strict_script_versioning: true,
    // a copy: posthog-js keeps the object it is given as its config
    session_recording: { ...sessionRecordingPrivacy },
  };
}

let posthogInitStarted = false;
let posthogClientPromise: Promise<import("posthog-js").PostHog> | undefined;
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
export function initPosthog(apiKey: string | undefined) {
  if (posthogInitStarted || !loadPosthog || !apiKey) return;
  posthogInitStarted = true;
  const clientPromise = loadPosthog().then((posthogModule) => {
    posthogModule.default.init(apiKey, posthogInitOptions());
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

const NO_GROUPS: PosthogGroup[] = [];

/** PostHog: the person is the platform user id — the same person in every app. `groups` re-sync
 *  when their identity changes, so a caller that builds them per render memoizes them. */
export function usePosthogIdentity(
  principal: { actor: string; email?: string },
  groups: PosthogGroup[] = NO_GROUPS,
) {
  useEffect(() => {
    syncPosthogContext({
      person: {
        distinctId: principal.actor,
        properties: principal.email ? { email: principal.email } : {},
      },
      groups,
    });
  }, [principal.actor, principal.email, groups]);
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
}
