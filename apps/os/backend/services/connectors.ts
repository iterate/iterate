/**
 * Connector Registry
 *
 * Defines known OAuth connectors with their URL patterns, scopes, and refresh capabilities.
 * Used by the egress proxy to provide helpful error messages when secrets are missing
 * or tokens need re-authentication.
 */

import { minimatch } from "minimatch";

export type ConnectorScope = "project" | "user";

export type Connector = {
  /** Human-readable name */
  name: string;
  /** URL patterns this connector handles (matched against request URL) */
  urlPatterns: string[];
  /** Whether this connector is project-scoped or user-scoped */
  scope: ConnectorScope;
  /** Whether tokens can be refreshed automatically */
  refreshable: boolean;
  /** Secret key used for this connector's access token */
  secretKey: string;
  /** OAuth token refresh endpoint (if refreshable) */
  refreshEndpoint?: string;
};

/**
 * Registry of known OAuth connectors.
 * These get special treatment in the egress proxy:
 * - Pre-check for existence with helpful connect URLs
 * - Automatic token refresh on 401
 * - Rich error messages with re-auth URLs
 */
export const CONNECTORS: Record<string, Connector> = {
  slack: {
    name: "Slack",
    urlPatterns: ["api.slack.com/*", "slack.com/api/*"],
    scope: "project",
    refreshable: true,
    secretKey: "slack.access_token",
    refreshEndpoint: "https://slack.com/api/oauth.v2.access",
  },
  google: {
    name: "Google",
    // Covers all Google APIs including Gmail, Sheets, Calendar, etc.
    urlPatterns: ["*.googleapis.com/*", "googleapis.com/*", "accounts.google.com/*"],
    scope: "user",
    refreshable: true,
    secretKey: "google.access_token",
    refreshEndpoint: "https://oauth2.googleapis.com/token",
  },
  github: {
    name: "GitHub",
    urlPatterns: ["api.github.com/*", "github.com/*"],
    scope: "project", // Project-scoped for sandbox git operations
    refreshable: false, // GitHub tokens don't refresh - re-auth needed
    secretKey: "github.access_token",
  },
};

/**
 * Get the connector that handles requests to a given URL.
 * Returns null if the URL is not associated with any known connector.
 */
export function getConnectorForUrl(url: string): Connector | null {
  // Extract host and path from URL
  let hostAndPath: string;
  try {
    const parsed = new URL(url);
    hostAndPath = parsed.host + parsed.pathname;
  } catch {
    // If URL parsing fails, try matching directly
    hostAndPath = url;
  }

  for (const connector of Object.values(CONNECTORS)) {
    for (const pattern of connector.urlPatterns) {
      if (matchesPattern(hostAndPath, pattern)) {
        return connector;
      }
    }
  }

  return null;
}

/**
 * Check if a URL host+path matches a pattern using minimatch.
 * Patterns support glob wildcards: "*.googleapis.com/*", "api.openai.com/*"
 *
 * Note: Patterns ending in /* are converted to /** for recursive matching.
 */
function matchesPattern(hostAndPath: string, pattern: string): boolean {
  // Convert /* to /** for recursive path matching
  const normalizedPattern = pattern.endsWith("/*") ? pattern.slice(0, -1) + "**" : pattern;
  return minimatch(hostAndPath, normalizedPattern);
}

/**
 * Build the connect URL for a connector.
 * This is where users go to set up the connection.
 */
export function getConnectUrl(
  connector: Connector,
  context: { orgSlug?: string; projectSlug?: string },
): string {
  if (!context.orgSlug || !context.projectSlug) {
    // Fallback if we don't have context
    return "/settings/connectors";
  }
  // GitHub connection is on /repo page, others on /connectors
  if (connector.name === "GitHub") {
    return `/orgs/${context.orgSlug}/projects/${context.projectSlug}/repo`;
  }
  return `/orgs/${context.orgSlug}/projects/${context.projectSlug}/connectors`;
}

/**
 * Build the full re-auth URL (with domain) for error messages.
 * Uses the VITE_PUBLIC_URL env var for the base URL.
 */
export function getFullReauthUrl(
  connector: Connector,
  context: { orgSlug?: string; projectSlug?: string },
  baseUrl?: string,
): string {
  const path = getConnectUrl(connector, context);
  const base = baseUrl || "https://iterate.com";
  return `${base}${path}`;
}
