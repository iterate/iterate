import { describe, expect, test } from "vitest";
import { z } from "zod/v4";
import { chromium, type Browser } from "playwright";
import { createE2EHelper, type AgentEvent } from "./helpers.ts";

/**
 * MCP E2E Tests
 *
 * Tests MCP server connections using the agent event system:
 * - No-auth: Direct connection without authentication
 * - OAuth: OAuth2 flow with auto-approve
 * - Bearer: Manual header configuration via Playwright
 * - Token Refresh: OAuth token expiration and automatic refresh
 *
 * Prerequisites:
 * - Mock MCP server running at MOCK_MCP_BASE_URL
 */

const TestEnv = z.object({
  MOCK_MCP_BASE_URL: z.string().default("https://mock.iterate.com"),
  MOCK_MCP_NO_AUTH_PATH: z.string().default("/no-auth"),
  MOCK_MCP_OAUTH_PATH: z.string().default("/oauth"),
  MOCK_MCP_BEARER_PATH: z.string().default("/bearer"),
});

function parseEnv() {
  const raw = TestEnv.parse({
    MOCK_MCP_BASE_URL: process.env.MOCK_MCP_BASE_URL,
    MOCK_MCP_NO_AUTH_PATH: process.env.MOCK_MCP_NO_AUTH_PATH,
    MOCK_MCP_OAUTH_PATH: process.env.MOCK_MCP_OAUTH_PATH,
    MOCK_MCP_BEARER_PATH: process.env.MOCK_MCP_BEARER_PATH,
  });

  return {
    ...raw,
    MOCK_MCP_NO_AUTH_SERVER_URL: resolveServerUrl(raw.MOCK_MCP_BASE_URL, raw.MOCK_MCP_NO_AUTH_PATH),
    MOCK_MCP_OAUTH_SERVER_URL: resolveServerUrl(raw.MOCK_MCP_BASE_URL, raw.MOCK_MCP_OAUTH_PATH),
    MOCK_MCP_BEARER_SERVER_URL: resolveServerUrl(raw.MOCK_MCP_BASE_URL, raw.MOCK_MCP_BEARER_PATH),
  };
}

function resolveServerUrl(base: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, base).toString();
}

describe("MCP server connections", () => {
  test("connects to mock MCP server (no auth) and uses tool", { timeout: 90_000 }, async () => {
    await using h = await createE2EHelper("mcp-no-auth");
    const env = parseEnv();
    const serverUrl = env.MOCK_MCP_NO_AUTH_SERVER_URL;

    const eventsBeforeMessage = await h.getEvents();

    const _connectMsg = await h.sendUserMessage(
      `Connect to the MCP server at ${serverUrl}. It doesn't require authentication.`,
    );

    await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeMessage, {
      timeout: 30_000,
    });
    console.log("MCP connection established (no auth)");

    const toolMsg = await h.sendUserMessage(
      `Using the MCP server, call mock_calculate with { operation: 'add', a: 12, b: 30 }. Return only the result.`,
    );

    const reply = await toolMsg.waitForReply({ timeout: 45_000 });
    expect(reply).toMatch(/42/);
    console.log("✅ Tool call successful (no auth)");
  });

  test("connects to mock MCP server (oauth) and uses tool", { timeout: 90_000 }, async () => {
    await using h = await createE2EHelper("mcp-oauth");
    const env = parseEnv();
    const serverUrl = env.MOCK_MCP_OAUTH_SERVER_URL;

    const eventsBeforeMessage = await h.getEvents();

    await h.sendUserMessage(`Connect to the MCP server at ${serverUrl}. It uses OAuth.`);

    const oauthEvent = await h.waitForEvent("MCP:OAUTH_REQUIRED", eventsBeforeMessage, {
      timeout: 30_000,
      select: (e: AgentEvent & { type: "MCP:OAUTH_REQUIRED" }) => e.data,
    });

    console.log("Got OAuth URL:", oauthEvent.oauthUrl);

    const eventsBeforeOAuth = await h.getEvents();

    await completeOAuthFlow(oauthEvent.oauthUrl, h.impersonationCookies);
    console.log("Completed OAuth flow");

    await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeOAuth, {
      timeout: 15_000,
    });
    console.log("MCP connection established (oauth)");

    const toolMsg = await h.sendUserMessage(
      `Using the MCP server, call userInfo to get the authenticated user info.`,
    );

    const reply = await toolMsg.waitForReply({ timeout: 45_000 });
    expect(reply).toMatch(/user/i);
    console.log("✅ Tool call successful (oauth)");
  });

  test("connects to mock MCP server (bearer) and uses tool", { timeout: 90_000 }, async () => {
    await using h = await createE2EHelper("mcp-bearer");
    const env = parseEnv();
    const serverUrl = `${env.MOCK_MCP_BEARER_SERVER_URL}?expected=test`;

    const eventsBeforeMessage = await h.getEvents();

    await h.sendUserMessage(
      `Connect to the MCP server at ${serverUrl}. It requires an Authorization header with Bearer token.`,
    );

    const paramsEvent = await h.waitForEvent("MCP:PARAMS_REQUIRED", eventsBeforeMessage, {
      timeout: 30_000,
      select: (e: AgentEvent & { type: "MCP:PARAMS_REQUIRED" }) => e.data,
    });

    console.log("Got params URL:", paramsEvent.paramsCollectionUrl);

    const eventsBeforeBearer = await h.getEvents();

    await fillBearerTokenViaPlaywright(paramsEvent.paramsCollectionUrl, h.impersonationCookies);
    console.log("Bearer token configured");

    await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeBearer, {
      timeout: 15_000,
    });
    console.log("MCP connection established (bearer)");

    const toolMsg = await h.sendUserMessage(
      `Using the MCP server, call mock_calculate with { operation: 'multiply', a: 7, b: 8 }. Return only the result.`,
    );

    const reply = await toolMsg.waitForReply({ timeout: 45_000 });
    expect(reply).toMatch(/56/);
    console.log("✅ Tool call successful (bearer)");
  });

  test(
    "refreshes OAuth token when expired and continues to work",
    { timeout: 3 * 60 * 1000 },
    async () => {
      await using h = await createE2EHelper("mcp-token-refresh");
      const env = parseEnv();
      const serverUrl = env.MOCK_MCP_OAUTH_SERVER_URL;
      const tokenExpirySeconds = 60; // Cloudflare KV minimum TTL

      const eventsBeforeMessage = await h.getEvents();

      await h.sendUserMessage(`Connect to the MCP server at ${serverUrl}. It uses OAuth.`);

      const oauthEvent = await h.waitForEvent("MCP:OAUTH_REQUIRED", eventsBeforeMessage, {
        timeout: 30_000,
        select: (e: AgentEvent & { type: "MCP:OAUTH_REQUIRED" }) => e.data,
      });

      const eventsBeforeOAuth = await h.getEvents();

      await completeOAuthFlow(oauthEvent.oauthUrl, h.impersonationCookies, tokenExpirySeconds);
      console.log(`Completed OAuth flow with ${tokenExpirySeconds}s token expiry`);

      await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeOAuth, {
        timeout: 10_000,
      });
      console.log("MCP connection established");

      const firstMsg = await h.sendUserMessage(`Using the MCP server, call userInfo.`);
      const firstReply = await firstMsg.waitForReply({ timeout: 15_000 });
      expect(firstReply).toMatch(/user/i);
      console.log("✅ First tool call successful (fresh token)");

      console.log(`Waiting ${tokenExpirySeconds + 10}s for token to expire...`);
      await new Promise((resolve) => setTimeout(resolve, (tokenExpirySeconds + 10) * 1000));

      const secondMsg = await h.sendUserMessage(
        `Using the MCP server, call greet with formal=true.`,
      );
      const secondReply = await secondMsg.waitForReply({ timeout: 30_000 });
      expect(secondReply).toMatch(/good day|hello|greet/i);
      console.log("✅ Second tool call successful (token was refreshed)");
    },
  );
});

// ============================================================================
// OAuth Flow
// ============================================================================

async function completeOAuthFlow(
  oauthUrl: string,
  cookies: string,
  expiresInSeconds?: number,
): Promise<void> {
  console.log("[OAuth] Step 1: Fetching OAuth URL:", oauthUrl);
  const redirectResponse = await fetch(oauthUrl, {
    method: "GET",
    redirect: "manual",
    headers: { cookie: cookies },
  });
  console.log("[OAuth] Step 1 response status:", redirectResponse.status);

  if (redirectResponse.status < 300 || redirectResponse.status >= 400) {
    const body = await redirectResponse.text();
    throw new Error(`OAuth redirect failed: ${redirectResponse.status}, ${body.slice(0, 500)}`);
  }

  const authLocation = redirectResponse.headers.get("location");
  console.log("[OAuth] Step 2: Auth location:", authLocation);
  if (!authLocation || authLocation.startsWith("/")) {
    throw new Error(`Invalid OAuth redirect: ${authLocation}`);
  }

  const authUrlObj = new URL(authLocation);
  authUrlObj.searchParams.set("auto_approve", "true");
  if (expiresInSeconds !== undefined) {
    authUrlObj.searchParams.set("expires_in", expiresInSeconds.toString());
  }

  console.log("[OAuth] Step 3: Fetching OAuth authorize:", authUrlObj.toString());
  const oauthResponse = await fetch(authUrlObj.toString(), {
    method: "GET",
    redirect: "manual",
  });
  console.log("[OAuth] Step 3 response status:", oauthResponse.status);

  if (oauthResponse.status < 300 || oauthResponse.status >= 400) {
    const body = await oauthResponse.text();
    throw new Error(`OAuth authorize failed: ${oauthResponse.status}, ${body.slice(0, 500)}`);
  }

  const currentUrl = oauthResponse.headers.get("location");
  console.log("[OAuth] Step 4: Following redirects, first URL:", currentUrl);
  const _redirectCount = 0;

  if (currentUrl) {
    const absoluteUrl = currentUrl.startsWith("http")
      ? currentUrl
      : `${process.env.VITE_PUBLIC_URL}${currentUrl}`;

    if (absoluteUrl.includes("/api/auth/integrations/callback")) {
      console.log(`[OAuth] Following callback: ${absoluteUrl}`);
      const response = await fetch(absoluteUrl, {
        method: "GET",
        redirect: "manual",
        headers: { cookie: cookies },
      });
      console.log(`[OAuth] Callback response status: ${response.status}`);
    } else {
      console.log(`[OAuth] Skipping non-callback redirect: ${absoluteUrl}`);
    }
  }

  console.log("[OAuth] Flow complete, waiting for agent to process...");
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("[OAuth] Done");
}

// ============================================================================
// Bearer Token Flow (Playwright)
// ============================================================================

async function fillBearerTokenViaPlaywright(paramsUrl: string, cookies: string): Promise<void> {
  console.log("[Bearer] Starting Playwright...");
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    const appURL = new URL(paramsUrl);

    console.log("[Bearer] Adding cookies for domain:", appURL.hostname);
    // Note: For localhost, we need to use the URL directly rather than setting domain
    const isLocalhost = appURL.hostname === "localhost" || appURL.hostname === "127.0.0.1";

    for (const pair of cookies.split("; ")) {
      const [name, ...rest] = pair.split("=");
      const value = rest.join("=");
      if (name && value) {
        console.log("[Bearer] Adding cookie:", name);
        const commonProps = {
          name,
          value,
          httpOnly: true,
          secure: appURL.protocol === "https:",
          sameSite: "Lax" as const,
        };

        // For localhost, use url instead of domain (Playwright handles it better)
        // Note: when using url, you cannot also specify path
        if (isLocalhost) {
          await context.addCookies([
            {
              ...commonProps,
              url: appURL.origin,
            },
          ]);
        } else {
          await context.addCookies([
            {
              ...commonProps,
              domain: appURL.hostname,
              path: "/",
            },
          ]);
        }
      }
    }

    const page = await context.newPage();

    // Only log failures, not every request (reduces overhead)
    page.on("requestfailed", (req) =>
      console.log("[Bearer] Request failed:", req.url(), req.failure()?.errorText),
    );

    console.log("[Bearer] Navigating to:", paramsUrl);
    const response = await page.goto(paramsUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log("[Bearer] Page loaded, status:", response?.status());

    console.log("[Bearer] Waiting for Save and Connect button...");
    await page.getByRole("button", { name: "Save and Connect" }).waitFor();
    console.log("[Bearer] Button found, looking for input...");

    const authInput = page.locator('form [data-slot="input"]').first();
    await authInput.waitFor({ state: "visible" });
    console.log("[Bearer] Input found, filling token...");
    await authInput.fill("Bearer test");

    console.log("[Bearer] Clicking Save and Connect...");

    // Click the button and wait for redirect to a real page (not mcp-params, not about:blank)
    await Promise.all([
      page.waitForURL(
        (url: URL) => url.href.startsWith("http") && !url.href.includes("/mcp-params"),
        {
          timeout: 60_000,
        },
      ),
      page.getByRole("button", { name: "Save and Connect" }).click(),
    ]);

    console.log("[Bearer] Redirect complete, final URL:", page.url());
  } finally {
    await browser.close();
  }
}
