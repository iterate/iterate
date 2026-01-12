/**
 * Base path configuration for running behind a reverse proxy.
 *
 * The HTML includes <base href="/"> which the proxy can rewrite to
 * the actual mount path (e.g., /machines/abc123/).
 *
 * Works locally without any proxy - just serves from "/".
 */

export function getBasePathFromDocument(): string {
  if (typeof document === "undefined") return "/";

  const baseElement = document.querySelector("base");
  if (baseElement?.href) {
    try {
      const url = new URL(baseElement.href);
      return url.pathname;
    } catch {
      return "/";
    }
  }
  return "/";
}
