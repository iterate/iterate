import { resolveMcpBaseUrl } from "./mcp-base-url.ts";

const projectSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeRequestHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
}

export function normalizeProjectHostnameBase(hostname: string) {
  const normalized = normalizeRequestHostname(hostname);
  return normalized.startsWith("*.") ? normalized.slice(2) : normalized;
}

export function normalizeCustomHostname(hostname: string | null | undefined) {
  const normalized = normalizeRequestHostname(hostname ?? "");
  return normalized === "" ? null : normalized;
}

export function isValidCustomHostname(hostname: string) {
  return hostnamePattern.test(hostname);
}

export function isReservedProjectHostname(
  hostname: string,
  projectHostnameBases: readonly string[],
) {
  return projectHostnameBases.some((rawBase) => {
    const base = normalizeProjectHostnameBase(rawBase);
    return hostname === base || hostname.endsWith(`.${base}`);
  });
}

export function resolveProjectSlugFromHostname(
  hostname: string | null | undefined,
  projectHostnameBases: readonly string[],
) {
  if (!hostname) return undefined;

  const normalizedHostname = normalizeRequestHostname(hostname);
  for (const rawBase of projectHostnameBases) {
    const base = normalizeProjectHostnameBase(rawBase);
    const suffix = `.${base}`;
    if (!normalizedHostname.endsWith(suffix)) continue;

    const slug = normalizedHostname.slice(0, -suffix.length);
    if (!slug || slug.includes(".")) continue;
    return projectSlugPattern.test(slug) ? slug : undefined;
  }

  return undefined;
}

export function buildProjectMcpUrl(input: {
  baseUrl?: string;
  mcpBaseUrl?: string;
  projectSlug: string;
  projectHostnameBases: readonly string[];
}) {
  try {
    return (
      resolveMcpBaseUrl({
        appBaseUrl: input.baseUrl,
        mcpBaseUrl: input.mcpBaseUrl,
      }) ?? null
    );
  } catch {
    return null;
  }
}

export function buildProjectWorkerUrl(input: {
  projectSlug: string;
  customHostname?: string | null;
  projectHostnameBases: readonly string[];
}) {
  if (!projectSlugPattern.test(input.projectSlug)) return null;
  const customHostname = normalizeCustomHostname(input.customHostname);
  if (customHostname) {
    if (!hostnamePattern.test(customHostname)) return null;
    return `https://${customHostname}`;
  }

  const projectHostnameBase = input.projectHostnameBases[0];
  if (!projectHostnameBase) return null;

  const normalizedBase = normalizeProjectHostnameBase(projectHostnameBase);
  if (!hostnamePattern.test(normalizedBase)) return null;

  return `https://${input.projectSlug}.${normalizedBase}`;
}
