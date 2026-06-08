export const OAUTH_RESOURCE_PARAMETER = "resource";

export function expandOAuthResourceAudienceVariants(resources: Iterable<string>) {
  return [...new Set(Array.from(resources).flatMap(oauthResourceAudienceVariants))];
}

export function oauthResourceAudienceVariants(resource: string) {
  const canonicalResource = normalizeOAuthResourceUrl(resource);
  const parsed = new URL(canonicalResource);
  if (parsed.pathname !== "/") return [canonicalResource];
  return [canonicalResource, `${parsed.origin}/`];
}

export function normalizeOAuthResourceUrl(resource: string) {
  const parsed = new URL(resource);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

export function copyMissingSearchParams(input: {
  targetUrl: string | URL;
  sourceSearch: string | URLSearchParams;
  paramNames: Iterable<string>;
  baseUrl?: string | URL;
}) {
  const targetUrl = new URL(input.targetUrl, input.baseUrl);
  const sourceSearchParams =
    input.sourceSearch instanceof URLSearchParams
      ? input.sourceSearch
      : new URLSearchParams(input.sourceSearch);

  for (const paramName of input.paramNames) {
    if (targetUrl.searchParams.has(paramName)) continue;

    for (const value of sourceSearchParams.getAll(paramName)) {
      targetUrl.searchParams.append(paramName, value);
    }
  }

  return targetUrl;
}
