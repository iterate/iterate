import { useEffect } from "react";
import { posthogPrivacy } from "./not-recorded.tsx";

// posthog-js only ever runs in the browser; the SSR branch keeps it out of the
// server bundle.
const loadPosthog = import.meta.env.SSR ? null : () => import("posthog-js");

export type PosthogProperties = Record<string, boolean | number | string>;

export interface PosthogGroup {
  type: string;
  key: string;
  properties: PosthogProperties;
}

// Only a deployment that should report is given a key (envs.ts: prd), so an initialized SDK sends.
// Replays record what people type, except secrets, and no event carries a secret URL
// (`posthogPrivacy`, not-recorded.tsx): a field that takes a secret replays as `***`, and a secret
// field (`SecretInput`, `SecretTextarea`) or a secret on screen (`NotRecorded`) is not recorded at
// all. `api_host` is the page's own `/e` proxy (proxyPosthogRequest in @iterate-com/shared/posthog).
// `defaults` sets the rest: pageviews on history changes, page leaves, identified-only person
// profiles, no URL hashes.
export function posthogInitOptions() {
  return {
    api_host: "/e",
    ui_host: "https://eu.posthog.com",
    defaults: "2026-08-30" as const,
    capture_exceptions: true,
    strict_script_versioning: true,
    ...posthogPrivacy(),
  };
}

let posthogInitStarted = false;
let posthogClientPromise: Promise<import("posthog-js").PostHog> | undefined;

/**
 * Once-per-app-load PostHog initialization. Nothing in our apps reads the
 * PostHog React context, so there is no provider: autocapture, session replay,
 * feature flags, surveys, and exception capture all run through `init`. This
 * would run at module scope per React's guidance for app
 * initialization, but the api key only arrives with loader data — so the
 * once-guard lives here at module scope and the first render with config in
 * hand kicks it off. Idempotent, so safe to call during render.
 */
export function initPosthog(apiKey: string | null | undefined) {
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

const NO_GROUPS: PosthogGroup[] = [];

/** PostHog: the person is the platform user id — the same person in every app — and `groups` are
 *  the caller's (memoized: a new array re-runs the effect). Following PostHog's guide, a different
 *  signed-in user resets first, so the two are never merged; identify and group skip what they
 *  already sent. */
export function usePosthogIdentity(
  principal: { actor: string; email?: string },
  groups: PosthogGroup[] = NO_GROUPS,
) {
  useEffect(() => {
    withPosthogClient((client) => {
      const identified = client.get_property("$user_id");
      if (typeof identified === "string" && identified !== principal.actor) client.reset();
      client.identify(principal.actor, principal.email ? { email: principal.email } : undefined);
      const types = new Set(groups.map((group) => group.type));
      if (Object.keys(client.getGroups()).some((type) => !types.has(type))) client.resetGroups();
      for (const group of groups) client.group(group.type, group.key, group.properties);
    });
  }, [principal.actor, principal.email, groups]);
}

/** Sign-out: the next person on this browser starts anonymous (PostHog's guide: reset on logout). */
export function resetPosthog() {
  withPosthogClient((client) => client.reset());
}

/** An error a route's error screen caught: React never lets it reach `window.onerror`, so
 *  `capture_exceptions` alone would miss it. */
export function capturePosthogException(error: unknown) {
  withPosthogClient((client) => client.captureException(error));
}
