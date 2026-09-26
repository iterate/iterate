import { useEffect } from "react";
import type { PostHogConfig } from "posthog-js";
import type { Principal } from "iterate/principal";

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
// `api_host` is the page's own `/e` proxy (proxyPosthogRequest in @iterate-com/shared/posthog).
// `defaults` sets the rest: pageviews on history changes, page leaves, identified-only person
// profiles, no URL hashes.
//
// Session replay keeps PostHog's privacy defaults (https://posthog.com/docs/session-replay/privacy):
// every input is masked, and a `ph-no-capture` element (`NotRecorded`) is not recorded. Masking is
// the PostHog project's setting, so nothing here sets it. The two additions are PostHog's own
// guidance for a secret in a URL: an invitation link's token is redacted from the page URLs a replay
// records (`maskCapturedNetworkRequestFn`, same page, "URL redaction") and from every event
// (`before_send`, https://posthog.com/docs/libraries/js/usage#redacting-information-in-events).
// That function replaces posthog-js's own scrubbing of request bodies, so headers and bodies are
// never recorded (https://posthog.com/docs/session-replay/network-recording).
export function posthogInitOptions() {
  return {
    api_host: "/e",
    ui_host: "https://eu.posthog.com",
    defaults: "2026-08-30",
    capture_exceptions: true,
    strict_script_versioning: true,
    session_recording: {
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        name: redactSecretPaths(request.name),
      }),
      recordHeaders: false,
      recordBody: false,
    },
    before_send: (event) => event && redactSecretPathsIn(event),
  } satisfies Partial<PostHogConfig>;
}

/** `text` with the secret in each URL path that carries one replaced by its route parameter:
 *  `/invitations/<token>` (the Dash's invitation link, which joins its organization) becomes
 *  `/invitations/:token`, URL-encoded too (`?next=%2Finvitations%2F<token>`, the Dash's step-up
 *  link). A new route whose path holds a secret adds its pattern here. */
function redactSecretPaths(text: string) {
  return text.replace(/((?:\/|%2F)invitations(?:\/|%2F))[^/?#&"'\s%]+/gi, "$1:token");
}

/** `value` with `redactSecretPaths` applied to every string and object key in it, except a replay
 *  batch's `$snapshot_data`: its payloads are gzipped, and `maskCapturedNetworkRequestFn` already
 *  redacted the URLs in them. The casts are safe: each branch rebuilds the value it was given with
 *  strings in place of strings, which TypeScript cannot follow through `Object.fromEntries`. */
function redactSecretPathsIn<T>(value: T): T {
  if (typeof value === "string") return redactSecretPaths(value) as T;
  if (Array.isArray(value)) return value.map(redactSecretPathsIn) as T;
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactSecretPaths(key),
        key === "$snapshot_data" ? entry : redactSecretPathsIn(entry),
      ]),
    ) as T;
  return value;
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
 *  already sent. A platform admin signed in as someone (`impersonatedBy`) is the admin: the clicks
 *  are theirs, never the person's. */
export function usePosthogIdentity(principal: Principal, groups: PosthogGroup[] = NO_GROUPS) {
  const { actor, email } = principal.impersonatedBy || principal;
  useEffect(() => {
    withPosthogClient((client) => {
      const identified = client.get_property("$user_id");
      if (typeof identified === "string" && identified !== actor) client.reset();
      client.identify(actor, email ? { email } : undefined);
      const types = new Set(groups.map((group) => group.type));
      if (Object.keys(client.getGroups()).some((type) => !types.has(type))) client.resetGroups();
      for (const group of groups) client.group(group.type, group.key, group.properties);
    });
  }, [actor, email, groups]);
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
