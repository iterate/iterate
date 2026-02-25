export type PublicBaseUrlType = "prefixed" | "subdomain-wildcard";

export interface ResolvePublicUrlInput {
  ITERATE_PUBLIC_BASE_URL?: string;
  ITERATE_PUBLIC_BASE_URL_TYPE?: PublicBaseUrlType;
  internalURL: string;
}

export class ResolvePublicUrlError extends Error {
  override name = "ResolvePublicUrlError";
}

function resolveMode(value: string | undefined): PublicBaseUrlType {
  const mode = value?.trim();
  if (!mode) return "prefixed";
  if (mode === "prefixed" || mode === "subdomain-wildcard") return mode;
  throw new ResolvePublicUrlError(`Unsupported ITERATE_PUBLIC_BASE_URL_TYPE: ${mode}`);
}

function parseBaseUrl(rawBaseUrl: string | undefined): URL {
  const trimmed = rawBaseUrl?.trim();
  if (!trimmed) {
    throw new ResolvePublicUrlError("ITERATE_PUBLIC_BASE_URL is required");
  }

  try {
    return new URL(trimmed);
  } catch {
    throw new ResolvePublicUrlError(`Invalid ITERATE_PUBLIC_BASE_URL: ${trimmed}`);
  }
}

function parseInternalUrl(rawInternalUrl: string): URL {
  const trimmed = rawInternalUrl.trim();
  if (!trimmed) {
    throw new ResolvePublicUrlError("internalURL is required");
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    return new URL(withProtocol);
  } catch {
    throw new ResolvePublicUrlError(`Invalid internalURL: ${rawInternalUrl}`);
  }
}

function firstHostnameLabel(hostname: string): string {
  const label = hostname.split(".").find((part) => part.length > 0);
  if (!label) {
    throw new ResolvePublicUrlError("internalURL hostname is required");
  }
  return label;
}

export function resolvePublicUrl(input: ResolvePublicUrlInput): string {
  const baseUrl = parseBaseUrl(input.ITERATE_PUBLIC_BASE_URL);
  const internalUrl = parseInternalUrl(input.internalURL);
  const mode = resolveMode(input.ITERATE_PUBLIC_BASE_URL_TYPE);

  const outputUrl = new URL(baseUrl.toString());

  if (mode === "prefixed") {
    const token = firstHostnameLabel(internalUrl.hostname);
    outputUrl.hostname = `${token}__${baseUrl.hostname}`;
  } else {
    outputUrl.hostname = internalUrl.hostname;
  }

  outputUrl.pathname = internalUrl.pathname || "/";
  outputUrl.search = internalUrl.search;
  outputUrl.hash = internalUrl.hash;

  return outputUrl.toString();
}
