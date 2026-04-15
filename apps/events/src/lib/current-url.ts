import { getGlobalStartContext } from "@tanstack/react-start";

const fallbackBaseUrl = "http://localhost/";

export function resolveLocationUrl(locationHref: string) {
  if (typeof window !== "undefined") {
    return new URL(locationHref, window.location.origin);
  }

  const requestUrl = getGlobalStartContext()?.rawRequest?.url ?? fallbackBaseUrl;
  return new URL(locationHref, requestUrl);
}
