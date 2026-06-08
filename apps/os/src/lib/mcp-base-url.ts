const localDevelopmentMcpPath = "/api/__mcp";

export function resolveMcpBaseUrl(input: {
  appBaseUrl?: string;
  mcpBaseUrl?: string;
  requestUrl?: string;
}) {
  const explicitMcpBaseUrl = input.mcpBaseUrl?.trim();
  if (explicitMcpBaseUrl) return normalizeUrlWithoutSearchOrHash(explicitMcpBaseUrl);

  const localBaseUrl = input.appBaseUrl?.trim() || input.requestUrl?.trim();
  if (!localBaseUrl) return null;

  const parsed = new URL(localBaseUrl);
  if (!isLocalhostHostname(parsed.hostname)) return null;

  return normalizeUrlWithoutSearchOrHash(
    new URL(localDevelopmentMcpPath, parsed.origin).toString(),
  );
}

export function normalizeUrlWithoutSearchOrHash(value: string) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function isLocalhostHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
