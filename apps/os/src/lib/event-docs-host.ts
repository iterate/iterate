import { normalizeRequestHostname } from "~/lib/project-host-routing.ts";

export const PRODUCTION_EVENT_DOCS_HOSTNAME = "events.iterate.com";

export function eventDocsHostnameForAppBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl) return null;

  const hostname = normalizeRequestHostname(new URL(baseUrl).hostname);
  if (hostname.startsWith("localhost") || hostname === "127.0.0.1" || hostname === "::1") {
    return null;
  }

  if (hostname === "os.iterate.com") return PRODUCTION_EVENT_DOCS_HOSTNAME;
  if (hostname.startsWith("os.")) return `events.${hostname.slice("os.".length)}`;
  return null;
}

export function isEventDocsHostname(input: {
  appBaseUrl: string | undefined;
  requestUrl: string | undefined;
}) {
  if (!input.requestUrl) return false;

  const requestHostname = normalizeRequestHostname(new URL(input.requestUrl).hostname);
  return (
    requestHostname === PRODUCTION_EVENT_DOCS_HOSTNAME ||
    requestHostname === eventDocsHostnameForAppBaseUrl(input.appBaseUrl)
  );
}
