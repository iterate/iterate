import { minimatch } from "minimatch";

const INGRESS_MATCHER_OPTIONS = {
  nocase: true,
  dot: true,
  noext: false,
  noglobstar: false,
} as const;

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export type IngressScheme = "http" | "https";

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

export function isCanonicalIngressHostCoveredByMatchers(params: {
  canonicalHost: string;
  hostMatchers: string[];
}): boolean {
  const { canonicalHost, hostMatchers } = params;
  const probeHostname = `3000__mach_test.${canonicalHost}`;
  return hostMatchers.some((matcher) => minimatch(probeHostname, matcher, INGRESS_MATCHER_OPTIONS));
}

export function getIngressSchemeFromPublicUrl(publicUrl: string): IngressScheme {
  const url = new URL(publicUrl);
  if (url.protocol === "http:") return "http";
  if (url.protocol === "https:") return "https";
  throw new Error(`Unsupported VITE_PUBLIC_URL protocol: ${url.protocol}`);
}

export function buildCanonicalMachineIngressUrl(params: {
  scheme: IngressScheme;
  canonicalHost: string;
  machineId: string;
  port: number;
  path?: string;
}): string {
  const { scheme, canonicalHost, machineId, port, path = "/" } = params;
  const normalizedHost = normalizeProjectIngressCanonicalHost(canonicalHost);
  if (!normalizedHost) {
    throw new Error(`Invalid canonical ingress host: '${canonicalHost}'`);
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${scheme}://${port}__${machineId}.${normalizedHost}${normalizedPath}`;
}
