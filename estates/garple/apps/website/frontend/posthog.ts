import posthog from "posthog-js";

export function initPostHog() {
  posthog.init(import.meta.env.VITE_POSTHOG_GARPLECOM_KEY, {
    api_host: "https://eu.i.posthog.com",
    defaults: "2025-05-24",
    person_profiles: "always",
    capture_exceptions: true
  });
}
