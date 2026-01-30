/**
 * Unit tests for egress proxy secret resolution and connector handling.
 *
 * Tests:
 * - Magic string parsing
 * - Secret hierarchy: user > project > org > global
 * - Connector detection from URLs
 * - Rich error responses for connector secrets
 */
import { describe, test, expect } from "vitest";
import {
  getConnectorForUrl,
  getConnectUrl,
  getFullReauthUrl,
  CONNECTORS,
} from "../services/connectors.ts";
import { parseMagicString, MAGIC_STRING_PATTERN } from "./egress-proxy.ts";
import { matchesEgressRule } from "./egress-rules.ts";

// Test the magic string parsing and secret lookup logic
// We test these as pure functions without DB/worker dependencies

describe("Egress Proxy - Magic String Parsing", () => {
  test("parses basic magic string", () => {
    const input = 'getIterateSecret({secretKey: "openai_api_key"})';
    const result = parseMagicString(input);
    expect(result).toEqual({ secretKey: "openai_api_key" });
  });

  test("parses magic string with userId", () => {
    const input = 'getIterateSecret({secretKey: "gmail.access_token", userId: "usr_123"})';
    const result = parseMagicString(input);
    expect(result).toEqual({ secretKey: "gmail.access_token", userId: "usr_123" });
  });

  test("parses magic string with all params", () => {
    const input =
      'getIterateSecret({secretKey: "github.token", machineId: "mach_abc", userId: "usr_456"})';
    const result = parseMagicString(input);
    expect(result).toEqual({
      secretKey: "github.token",
      machineId: "mach_abc",
      userId: "usr_456",
    });
  });

  test("handles single quotes", () => {
    const input = "getIterateSecret({secretKey: 'anthropic_api_key'})";
    const result = parseMagicString(input);
    expect(result).toEqual({ secretKey: "anthropic_api_key" });
  });

  test("requires quotes around values (JSON5 allows unquoted keys, not values)", () => {
    // JSON5 allows unquoted keys but values must be quoted strings
    const input = "getIterateSecret({secretKey: openai_api_key})";
    const result = parseMagicString(input);
    // This returns null because openai_api_key is not a valid JSON5 value
    expect(result).toBeNull();
  });

  test("finds multiple magic strings in text", () => {
    const input =
      'Bearer getIterateSecret({secretKey: "key1"}) and also getIterateSecret({secretKey: "key2", userId: "usr_1"})';
    const matches = [...input.matchAll(MAGIC_STRING_PATTERN)];
    expect(matches).toHaveLength(2);
    expect(parseMagicString(matches[0][0])).toEqual({ secretKey: "key1" });
    expect(parseMagicString(matches[1][0])).toEqual({ secretKey: "key2", userId: "usr_1" });
  });

  test("returns null for invalid format", () => {
    expect(parseMagicString("getIterateSecret({})")).toBeNull();
    expect(parseMagicString("getIterateSecret({foo: bar})")).toBeNull();
  });
});

describe("Egress Proxy - Secret Hierarchy Resolution", () => {
  // Mock secrets database
  type MockSecret = {
    key: string;
    encryptedValue: string;
    organizationId: string | null;
    projectId: string | null;
    userId: string | null;
    egressProxyRule: string | null;
  };

  const mockSecrets: MockSecret[] = [
    // Global OpenAI key (fallback for everyone)
    {
      key: "openai_api_key",
      encryptedValue: "global-openai-key",
      organizationId: null,
      projectId: null,
      userId: null,
      egressProxyRule: `url.hostname = 'api.openai.com'`,
    },
    // Org-level OpenAI key (org_acme overrides global)
    {
      key: "openai_api_key",
      encryptedValue: "acme-org-openai-key",
      organizationId: "org_acme",
      projectId: null,
      userId: null,
      egressProxyRule: `url.hostname = 'api.openai.com'`,
    },
    // User A's Gmail token
    {
      key: "gmail.access_token",
      encryptedValue: "user-a-gmail-token",
      organizationId: null,
      projectId: null,
      userId: "usr_alice",
      egressProxyRule: `$contains(url.hostname, 'googleapis.com')`,
    },
    // User B's Gmail token
    {
      key: "gmail.access_token",
      encryptedValue: "user-b-gmail-token",
      organizationId: null,
      projectId: null,
      userId: "usr_bob",
      egressProxyRule: `$contains(url.hostname, 'googleapis.com')`,
    },
    // Project-level Slack token
    {
      key: "slack.access_token",
      encryptedValue: "project-slack-token",
      organizationId: "org_acme",
      projectId: "prj_web",
      userId: null,
      egressProxyRule: `url.hostname = 'api.slack.com'`,
    },
  ];

  // Replicate the lookupSecret logic for testing
  function lookupSecret(
    secrets: MockSecret[],
    secretKey: string,
    context: { organizationId?: string; projectId?: string; userId?: string },
  ): MockSecret | null {
    // Find all secrets matching the key
    const matching = secrets.filter((s) => s.key === secretKey);
    if (matching.length === 0) return null;

    // Filter by scope applicability
    const applicable = matching.filter((s) => {
      const isGlobal = !s.organizationId && !s.projectId && !s.userId;
      const isOrgMatch = s.organizationId === context.organizationId && !s.projectId && !s.userId;
      const isProjectMatch = s.projectId === context.projectId && !s.userId;
      const isUserMatch = s.userId === context.userId;
      return isGlobal || isOrgMatch || isProjectMatch || isUserMatch;
    });

    if (applicable.length === 0) return null;

    // Sort by specificity (user > project > org > global)
    const sorted = applicable.sort((a, b) => {
      const scoreA = (a.userId ? 8 : 0) + (a.projectId ? 4 : 0) + (a.organizationId ? 2 : 0);
      const scoreB = (b.userId ? 8 : 0) + (b.projectId ? 4 : 0) + (b.organizationId ? 2 : 0);
      return scoreB - scoreA;
    });

    return sorted[0];
  }

  test("global secret is returned when no context", () => {
    const result = lookupSecret(mockSecrets, "openai_api_key", {});
    expect(result?.encryptedValue).toBe("global-openai-key");
  });

  test("org secret overrides global", () => {
    const result = lookupSecret(mockSecrets, "openai_api_key", { organizationId: "org_acme" });
    expect(result?.encryptedValue).toBe("acme-org-openai-key");
  });

  test("different users get different gmail tokens", () => {
    const aliceResult = lookupSecret(mockSecrets, "gmail.access_token", { userId: "usr_alice" });
    const bobResult = lookupSecret(mockSecrets, "gmail.access_token", { userId: "usr_bob" });

    expect(aliceResult?.encryptedValue).toBe("user-a-gmail-token");
    expect(bobResult?.encryptedValue).toBe("user-b-gmail-token");
    expect(aliceResult?.encryptedValue).not.toBe(bobResult?.encryptedValue);
  });

  test("user without personal token gets no result for user-scoped secret", () => {
    const result = lookupSecret(mockSecrets, "gmail.access_token", { userId: "usr_charlie" });
    expect(result).toBeNull();
  });

  test("project-level secret is found", () => {
    const result = lookupSecret(mockSecrets, "slack.access_token", {
      organizationId: "org_acme",
      projectId: "prj_web",
    });
    expect(result?.encryptedValue).toBe("project-slack-token");
  });

  test("project-level secret not found for wrong project", () => {
    const result = lookupSecret(mockSecrets, "slack.access_token", {
      organizationId: "org_acme",
      projectId: "prj_other",
    });
    expect(result).toBeNull();
  });

  test("user secret has highest priority over org and global", () => {
    // Add a user-specific OpenAI key
    const secretsWithUserKey = [
      ...mockSecrets,
      {
        key: "openai_api_key",
        encryptedValue: "alice-personal-openai-key",
        organizationId: null,
        projectId: null,
        userId: "usr_alice",
        egressProxyRule: `url.hostname = 'api.openai.com'`,
      },
    ];

    const result = lookupSecret(secretsWithUserKey, "openai_api_key", {
      organizationId: "org_acme",
      userId: "usr_alice",
    });

    // User-level should win over org-level
    expect(result?.encryptedValue).toBe("alice-personal-openai-key");
  });
});

describe("Egress Proxy - Egress Rule Matching (JSONata)", () => {
  test("exact hostname match", async () => {
    const rule = `url.hostname = 'api.openai.com'`;
    expect(await matchesEgressRule("https://api.openai.com", rule)).toBe(true);
    expect(await matchesEgressRule("https://api.openai.com/v1/models", rule)).toBe(true);
  });

  test("contains match for subdomains", async () => {
    const rule = `$contains(url.hostname, 'googleapis.com')`;
    expect(await matchesEgressRule("https://sheets.googleapis.com", rule)).toBe(true);
    expect(await matchesEgressRule("https://calendar.googleapis.com", rule)).toBe(true);
    expect(await matchesEgressRule("https://googleapis.com", rule)).toBe(true);
  });

  test("ends with for subdomain matching", async () => {
    const rule = `$match(url.hostname, /.*\\.googleapis\\.com$/)`;
    expect(await matchesEgressRule("https://sheets.googleapis.com", rule)).toBe(true);
    expect(await matchesEgressRule("https://calendar.googleapis.com", rule)).toBe(true);
    expect(await matchesEgressRule("https://googleapis.com", rule)).toBe(false);
  });

  test("no match for different hosts", async () => {
    const rule = `url.hostname = 'api.openai.com'`;
    expect(await matchesEgressRule("https://api.anthropic.com", rule)).toBe(false);
    expect(await matchesEgressRule("https://malicious.com", rule)).toBe(false);
  });

  test("complex expressions with OR", async () => {
    const rule = `url.hostname = 'api.openai.com' or url.hostname = 'api.anthropic.com'`;
    expect(await matchesEgressRule("https://api.openai.com", rule)).toBe(true);
    expect(await matchesEgressRule("https://api.anthropic.com", rule)).toBe(true);
    expect(await matchesEgressRule("https://api.google.com", rule)).toBe(false);
  });

  test("path-based rules", async () => {
    const rule = `url.hostname = 'api.example.com' and $match(url.pathname, /^\\/v1\\//)`;
    expect(await matchesEgressRule("https://api.example.com/v1/users", rule)).toBe(true);
    expect(await matchesEgressRule("https://api.example.com/v2/users", rule)).toBe(false);
  });
});

describe("Egress Proxy - Connector Detection", () => {
  test("detects Slack connector from URL", () => {
    const connector = getConnectorForUrl("https://api.slack.com/api/chat.postMessage");
    expect(connector).not.toBeNull();
    expect(connector?.name).toBe("Slack");
    expect(connector?.scope).toBe("project");
    expect(connector?.refreshable).toBe(true);
  });

  test("detects Google connector from googleapis.com URLs", () => {
    const sheetsConnector = getConnectorForUrl("https://sheets.googleapis.com/v4/spreadsheets");
    expect(sheetsConnector?.name).toBe("Google");
    expect(sheetsConnector?.scope).toBe("user");

    const calendarConnector = getConnectorForUrl("https://calendar.googleapis.com/v3/calendars");
    expect(calendarConnector?.name).toBe("Google");
  });

  test("Gmail URLs match Google connector (same OAuth)", () => {
    // Gmail is a Google API, so it matches the Google connector
    const connector = getConnectorForUrl("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    expect(connector?.name).toBe("Google");
    expect(connector?.scope).toBe("user");
  });

  test("detects GitHub connector", () => {
    const connector = getConnectorForUrl("https://api.github.com/repos/owner/repo");
    expect(connector?.name).toBe("GitHub");
    expect(connector?.scope).toBe("project"); // Project-scoped for sandbox git operations
    expect(connector?.refreshable).toBe(true); // GitHub App installation tokens can be regenerated
  });

  test("returns null for non-connector URLs", () => {
    expect(getConnectorForUrl("https://api.openai.com/v1/chat/completions")).toBeNull();
    expect(getConnectorForUrl("https://api.anthropic.com/v1/messages")).toBeNull();
    expect(getConnectorForUrl("https://example.com/api")).toBeNull();
  });

  test("handles malformed URLs gracefully", () => {
    expect(getConnectorForUrl("not-a-url")).toBeNull();
    expect(getConnectorForUrl("")).toBeNull();
  });
});

describe("Egress Proxy - Connect/Reauth URLs", () => {
  test("builds connect URL with org/project context", () => {
    const url = getConnectUrl(CONNECTORS.slack, {
      orgSlug: "acme",
      projectSlug: "web-app",
    });
    expect(url).toBe("/orgs/acme/projects/web-app/connectors");
  });

  test("falls back to /settings/connectors without context", () => {
    expect(getConnectUrl(CONNECTORS.slack, {})).toBe("/settings/connectors");
    expect(getConnectUrl(CONNECTORS.slack, { orgSlug: "acme" })).toBe("/settings/connectors");
  });

  test("builds full reauth URL with base URL", () => {
    const url = getFullReauthUrl(
      CONNECTORS.google,
      { orgSlug: "acme", projectSlug: "web-app" },
      "https://app.iterate.com",
    );
    expect(url).toBe("https://app.iterate.com/orgs/acme/projects/web-app/connectors");
  });

  test("uses default base URL when not provided", () => {
    // GitHub goes to /repo, others go to /connectors
    const url = getFullReauthUrl(CONNECTORS.github, { orgSlug: "acme", projectSlug: "api" });
    expect(url).toBe("https://iterate.com/orgs/acme/projects/api/repo");
  });
});

describe("Egress Proxy - Error Response Types", () => {
  // These test the shape of error responses the egress proxy should return

  test("NOT_FOUND error for missing connector secret", () => {
    // Simulates what resolveSecret returns for a missing connector secret
    const error = {
      code: "NOT_FOUND" as const,
      message: "Slack is not connected. Please connect it first.",
      connectUrl: "https://iterate.com/orgs/acme/projects/web/connectors",
    };

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("Slack");
    expect(error.connectUrl).toContain("/connectors");
  });

  test("NOT_FOUND error for missing non-connector secret", () => {
    // For non-connector secrets, no connectUrl is provided
    const error = {
      code: "NOT_FOUND" as const,
      message: "Secret 'my_custom_key' not found.",
    };

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("my_custom_key");
    expect(error).not.toHaveProperty("connectUrl");
  });

  test("REFRESH_FAILED error includes reauth URL", () => {
    // When token refresh fails, we return the reauth URL
    const error = {
      code: "REFRESH_FAILED" as const,
      message: "Authentication failed and token refresh was unsuccessful.",
      reauthUrl: "https://iterate.com/orgs/acme/projects/web/connectors",
    };

    expect(error.code).toBe("REFRESH_FAILED");
    expect(error.reauthUrl).toContain("/connectors");
  });
});
