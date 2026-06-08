import { resolveMcpBaseUrl } from "~/lib/mcp-base-url.ts";

export function matchMcpRequestUrl(input: {
  appBaseUrl?: string;
  mcpBaseUrl?: string;
  requestUrl: string;
}) {
  const mcpBaseUrl = resolveMcpBaseUrl({
    appBaseUrl: input.appBaseUrl,
    mcpBaseUrl: input.mcpBaseUrl,
    requestUrl: input.requestUrl,
  });
  if (!mcpBaseUrl) return null;

  const requestUrl = new URL(input.requestUrl);
  const baseUrl = normalizeMcpBaseUrl(mcpBaseUrl);
  if (requestUrl.origin !== baseUrl.origin) return null;

  const basePathname = stripTrailingSlash(baseUrl.pathname);
  const requestPathname = stripTrailingSlash(requestUrl.pathname);
  const isRootMount = basePathname === "";
  const matchesBasePath =
    isRootMount ||
    requestPathname === basePathname ||
    requestUrl.pathname.startsWith(`${basePathname}/`);
  if (!matchesBasePath) return null;

  const relativePathname = isRootMount
    ? requestUrl.pathname
    : requestUrl.pathname.slice(basePathname.length) || "/";

  return {
    relativePathname: relativePathname.startsWith("/") ? relativePathname : `/${relativePathname}`,
  };
}

export function normalizeMcpBaseUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  url.search = "";
  url.hash = "";
  url.pathname = stripTrailingSlash(url.pathname) || "/";
  return url;
}

export function stripTrailingSlash(pathname: string) {
  return pathname.replace(/\/+$/, "");
}
