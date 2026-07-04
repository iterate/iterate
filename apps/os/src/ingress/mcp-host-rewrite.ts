import { normalizeIngressHost } from "./host-headers.ts";
import { MCP_START_MOUNT_PATH } from "~/lib/mcp-base-url.ts";

/**
 * When the MCP host is a dedicated hostname (distinct from the app host),
 * rewrite requests on it onto the app's `/api/mcp` mount path.
 *
 * Lives in its own module (not src/worker.ts) so unit tests can import it
 * without loading the whole product's module graph in Node.
 */
export function rewriteMcpHostRequest(input: {
  config: { baseUrl?: string; mcp?: { baseUrl: string } };
  request: Request;
}) {
  if (!input.config.baseUrl || !input.config.mcp?.baseUrl) return null;

  const requestUrl = new URL(input.request.url);
  const mcpUrl = new URL(input.config.mcp.baseUrl);
  if (normalizeIngressHost(requestUrl.hostname) !== normalizeIngressHost(mcpUrl.hostname)) {
    return null;
  }

  const appUrl = new URL(input.config.baseUrl);
  if (normalizeIngressHost(mcpUrl.hostname) === normalizeIngressHost(appUrl.hostname)) return null;

  const pathSuffix = requestUrl.pathname.startsWith(`${MCP_START_MOUNT_PATH}/`)
    ? requestUrl.pathname.slice(MCP_START_MOUNT_PATH.length)
    : requestUrl.pathname === MCP_START_MOUNT_PATH || requestUrl.pathname === "/"
      ? ""
      : requestUrl.pathname;

  requestUrl.protocol = appUrl.protocol;
  requestUrl.host = appUrl.host;
  requestUrl.pathname = `${MCP_START_MOUNT_PATH}${pathSuffix}`;

  return new Request(requestUrl, input.request);
}
