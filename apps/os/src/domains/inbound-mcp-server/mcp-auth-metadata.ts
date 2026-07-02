import {
  expandOAuthResourceAudienceVariants,
  normalizeOAuthResourceUrl,
} from "@iterate-com/shared/oauth-resource";
import { ITERATE_PROJECT_SELECTION_SCOPE } from "@iterate-com/shared/auth-claims";
import { MCP_START_MOUNT_PATH, resolveMcpBaseUrl } from "~/lib/mcp-base-url.ts";
import type { RequestContext } from "~/request-context.ts";

export const mcpOAuthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  ITERATE_PROJECT_SELECTION_SCOPE,
];

export function isMcpProtectedResourceMetadataPath(pathname: string) {
  return (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname.startsWith("/.well-known/oauth-protected-resource/") ||
    pathname === `${MCP_START_MOUNT_PATH}/.well-known/oauth-protected-resource` ||
    pathname.startsWith(`${MCP_START_MOUNT_PATH}/.well-known/oauth-protected-resource/`)
  );
}

export function publicMcpResourceUrl(input: { context: RequestContext; request: Request }) {
  const canonicalResource = canonicalMcpResourceUrl(input);
  const publicUrl = publicRequestUrl(input.request);
  const canonicalUrl = new URL(canonicalResource);
  if (sameHostname(publicUrl, canonicalUrl)) return canonicalResource;

  const appResource = configuredAppMcpResourceUrl(input);
  if (appResource && sameHostname(publicUrl, new URL(appResource))) return appResource;

  return canonicalResource;
}

export function acceptedMcpResourceAudiences(input: { context: RequestContext; request: Request }) {
  const configuredAppResource = configuredAppMcpResourceUrl(input);
  return expandOAuthResourceAudienceVariants([
    canonicalMcpResourceUrl(input),
    ...(configuredAppResource == null ? [] : [configuredAppResource]),
  ]);
}

export function publicRequestUrl(request: Request) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.replace(/:$/, "").trim();
  if (forwardedHost) url.host = forwardedHost;
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  return url;
}

export function mcpChallengeHeader(input: {
  error: "invalid_token" | "insufficient_scope";
  errorDescription: string;
  metadataUrl: string;
}) {
  return [
    `Bearer error="${escapeHeaderParam(input.error)}"`,
    `error_description="${escapeHeaderParam(input.errorDescription)}"`,
    `resource_metadata="${escapeHeaderParam(input.metadataUrl)}"`,
    `scope="${escapeHeaderParam(mcpOAuthScopes.join(" "))}"`,
  ].join(", ");
}

function canonicalMcpResourceUrl(input: { context: RequestContext; request: Request }) {
  const rawUrl = resolveMcpBaseUrl({
    appBaseUrl: input.context.config.baseUrl,
    mcpBaseUrl: input.context.config.mcp?.baseUrl,
    requestUrl: input.request.url,
  });
  if (!rawUrl) throw new Error("APP_CONFIG_MCP__BASE_URL is required for MCP requests.");
  return rawUrl;
}

function configuredAppMcpResourceUrl(input: { context: RequestContext }) {
  const appBaseUrl = input.context.config.baseUrl?.trim();
  if (!appBaseUrl) return null;
  return normalizeOAuthResourceUrl(new URL(MCP_START_MOUNT_PATH, appBaseUrl).toString());
}

function sameHostname(left: URL, right: URL) {
  return left.hostname.toLowerCase() === right.hostname.toLowerCase();
}

function escapeHeaderParam(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
