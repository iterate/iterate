const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export type IngressScheme = "http" | "https";

/**
 * Validate and normalize a hostname (no wildcard, scheme, port, or path).
 * Used by alchemy.run.ts to validate PROJECT_INGRESS_DOMAIN at deploy time.
 */
export function normalizeProjectIngressCanonicalHost(rawHost: string): string | null {
  const canonicalHost = rawHost.trim().toLowerCase();
  if (!canonicalHost) return null;
  if (canonicalHost.includes("*")) return null;
  if (canonicalHost.includes(":")) return null;
  if (canonicalHost.includes("/") || canonicalHost.includes("?") || canonicalHost.includes("#")) {
    return null;
  }
  if (canonicalHost.startsWith(".") || canonicalHost.endsWith(".")) return null;
  if (!HOSTNAME_PATTERN.test(canonicalHost)) return null;
  return canonicalHost;
}

export function getIngressSchemeFromPublicUrl(publicUrl: string): IngressScheme {
  const url = new URL(publicUrl);
  if (url.protocol === "http:") return "http";
  if (url.protocol === "https:") return "https";
  throw new Error(`Unsupported VITE_PUBLIC_URL protocol: ${url.protocol}`);
}
