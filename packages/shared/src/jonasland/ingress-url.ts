export type PublicIngressUrlType = "dunder-prefix" | "subdomain-host";
export type PublicIngressUrlTypeInput = PublicIngressUrlType | "" | undefined | null;

export interface ResolvePublicIngressUrlInput {
  ingressHost?: string;
  ingressRoutingType?: PublicIngressUrlTypeInput;
  defaultIngressAppSlug?: string;
  internalUrl: string;
}

export class PublicIngressUrlError extends Error {
  override name = "PublicIngressUrlError";
}

export function normalizePublicIngressUrlType(
  type: PublicIngressUrlTypeInput,
): PublicIngressUrlType {
  const normalized = typeof type === "string" ? type.trim() : "";
  if (!normalized || normalized === "subdomain-host") {
    return "subdomain-host";
  }
  if (normalized === "dunder-prefix") {
    return "dunder-prefix";
  }
  throw new PublicIngressUrlError(`Unsupported public base URL type: ${normalized}`);
}

function parsePublicBaseUrl(rawBaseUrl: string | undefined): URL {
  const trimmed = rawBaseUrl?.trim();
  if (!trimmed) {
    throw new PublicIngressUrlError("publicBaseHost is required");
  }

  try {
    const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
      ? trimmed
      : `${inferPublicScheme(trimmed)}://${trimmed}`;
    return new URL(normalized);
  } catch {
    throw new PublicIngressUrlError(`Invalid publicBaseHost: ${trimmed}`);
  }
}

function inferPublicScheme(hostLike: string): "http" | "https" {
  const normalized = hostLike.trim().toLowerCase();
  const host =
    normalized.includes(":") && !normalized.endsWith("]") ? normalized.split(":")[0] : normalized;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) {
    return "http";
  }
  return "https";
}

function parseInternalUrl(rawInternalUrl: string): URL {
  const trimmed = rawInternalUrl.trim();
  if (!trimmed) {
    throw new PublicIngressUrlError("internalUrl is required");
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    return new URL(withProtocol);
  } catch {
    throw new PublicIngressUrlError(`Invalid internalUrl: ${rawInternalUrl}`);
  }
}

function firstHostnameLabel(hostname: string): string {
  const label = hostname.split(".").find((part) => part.length > 0);
  if (!label) {
    throw new PublicIngressUrlError("internalUrl hostname is required");
  }
  return label;
}

export function resolvePublicIngressUrl(input: ResolvePublicIngressUrlInput): string {
  const baseUrl = parsePublicBaseUrl(input.ingressHost);
  const internalUrl = parseInternalUrl(input.internalUrl);
  const mode = normalizePublicIngressUrlType(input.ingressRoutingType);
  const outputUrl = new URL(baseUrl.toString());
  const token = firstHostnameLabel(internalUrl.hostname);
  const defaultIngressAppSlug = input.defaultIngressAppSlug?.trim().toLowerCase();

  if (defaultIngressAppSlug && token === defaultIngressAppSlug) {
    outputUrl.pathname = internalUrl.pathname || "/";
    outputUrl.search = internalUrl.search;
    outputUrl.hash = internalUrl.hash;
    return outputUrl.toString();
  }

  if (mode === "dunder-prefix") {
    outputUrl.hostname = `${token}__${baseUrl.hostname}`;
  } else {
    outputUrl.hostname = `${token}.${baseUrl.hostname}`;
  }

  outputUrl.pathname = internalUrl.pathname || "/";
  outputUrl.search = internalUrl.search;
  outputUrl.hash = internalUrl.hash;

  return outputUrl.toString();
}
