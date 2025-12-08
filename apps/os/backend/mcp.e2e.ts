import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod/v4";
import { chromium, type Browser } from "playwright";
import {
  createTestHelper,
  getAuthedTrpcClient,
  getServiceAuthCredentials,
  getImpersonatedTrpcClient,
  type AgentEvent,
} from "../evals/helpers.ts";
import { fetch } from "./fetch.ts";

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

interface TestContext {
  adminTrpc: Awaited<ReturnType<typeof getAuthedTrpcClient>>["client"];
  userTrpc: Awaited<ReturnType<typeof getImpersonatedTrpcClient>>["trpcClient"];
  impersonationCookies: string;
  testUserId: string;
  estateId: string;
  cleanup: () => Promise<void>;
}

let ctx: TestContext;

beforeAll(async () => {
  const { client: adminTrpc } = await getAuthedTrpcClient();
  const { sessionCookies } = await getServiceAuthCredentials();

  // Create test user with organization and estate
  const { user: testUser } = await adminTrpc.testing.createTestUser.mutate({});
  const { estate, organization } = await adminTrpc.testing.createOrganizationAndEstate.mutate({
    userId: testUser.id,
  });

  const { trpcClient: userTrpc, impersonationCookies } = await getImpersonatedTrpcClient({
    userId: testUser.id,
    adminSessionCookes: sessionCookies,
  });

  ctx = {
    adminTrpc,
    userTrpc,
    impersonationCookies,
    testUserId: testUser.id,
    estateId: estate.id,
    cleanup: async () => {
      await adminTrpc.testing.deleteOrganization.mutate({ organizationId: organization.id });
      await adminTrpc.admin.deleteUserByEmail.mutate({ email: testUser.email });
    },
  };
});

afterAll(async () => {
  await ctx?.cleanup();
});

describe("MCP server connections", () => {
  test("connects to mock MCP server (no auth) and uses tool", { timeout: 30_000 }, async () => {
    const env = parseEnv();
    const serverUrl = env.MOCK_MCP_NO_AUTH_SERVER_URL;

    const h = await createTestHelper({
      trpcClient: ctx.userTrpc,
      inputSlug: "mcp-no-auth",
      userId: ctx.testUserId,
    });

    // Save events BEFORE sending the message
    const eventsBeforeMessage = await h.getEvents();

    // Ask the agent to connect to the MCP server
    const _connectMsg = await h.sendUserMessage(
      `Connect to the MCP server at ${serverUrl}. It doesn't require authentication.`,
    );

    // Wait for connection established (using events from BEFORE the message)
    await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeMessage, {
      timeout: 15_000,
    });
    console.log("MCP connection established (no auth)");

    // Ask the agent to use a tool
    const toolMsg = await h.sendUserMessage(
      `Using the MCP server, call mock_calculate with { operation: 'add', a: 12, b: 30 }. Return only the result.`,
    );

    const reply = await toolMsg.waitForReply({ timeout: 15_000 });
    expect(reply).toMatch(/42/);
    console.log("✅ Tool call successful (no auth)");
  });

  test("connects to mock MCP server (oauth) and uses tool", { timeout: 60_000 }, async () => {
    const env = parseEnv();
    const serverUrl = env.MOCK_MCP_OAUTH_SERVER_URL;

    const h = await createTestHelper({
      trpcClient: ctx.userTrpc,
      inputSlug: "mcp-oauth",
      userId: ctx.testUserId,
    });

    // Save events BEFORE sending the message
    const eventsBeforeMessage = await h.getEvents();

    // Ask the agent to connect to the MCP server
    await h.sendUserMessage(`Connect to the MCP server at ${serverUrl}. It uses OAuth.`);

    // Wait for OAuth required event (using events from BEFORE the message)
    const oauthEvent = await h.waitForEvent("MCP:OAUTH_REQUIRED", eventsBeforeMessage, {
      timeout: 15_000,
      select: (e: AgentEvent & { type: "MCP:OAUTH_REQUIRED" }) => e.data,
    });

    console.log("Got OAuth URL:", oauthEvent.oauthUrl);

    // Save events BEFORE completing OAuth so we can detect new events after
    const eventsBeforeOAuth = await h.getEvents();

    // Complete OAuth flow
    await completeOAuthFlow(oauthEvent.oauthUrl, ctx.impersonationCookies);
    console.log("Completed OAuth flow");

    // Wait for connection established (using events from BEFORE OAuth was completed)
    await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeOAuth, {
      timeout: 10_000,
    });
    console.log("MCP connection established (oauth)");

    // Ask the agent to use a tool
    const toolMsg = await h.sendUserMessage(
      `Using the MCP server, call userInfo to get the authenticated user info.`,
    );

    const reply = await toolMsg.waitForReply({ timeout: 15_000 });
    expect(reply).toMatch(/user/i);
    console.log("✅ Tool call successful (oauth)");
  });

  test("connects to mock MCP server (bearer) and uses tool", { timeout: 60_000 }, async () => {
    const env = parseEnv();
    const serverUrl = `${env.MOCK_MCP_BEARER_SERVER_URL}?expected=test`;

    const h = await createTestHelper({
      trpcClient: ctx.userTrpc,
      inputSlug: "mcp-bearer",
      userId: ctx.testUserId,
    });

    // Save events BEFORE sending the message
    const eventsBeforeMessage = await h.getEvents();

    // Ask the agent to connect to the MCP server with bearer auth requirement
    await h.sendUserMessage(
      `Connect to the MCP server at ${serverUrl}. It requires an Authorization header with Bearer token.`,
    );

    // Wait for params required event (using events from BEFORE the message)
    const paramsEvent = await h.waitForEvent("MCP:PARAMS_REQUIRED", eventsBeforeMessage, {
      timeout: 15_000,
      select: (e: AgentEvent & { type: "MCP:PARAMS_REQUIRED" }) => e.data,
    });

    console.log("Got params URL:", paramsEvent.paramsCollectionUrl);

    // Save events BEFORE filling bearer token so we can detect new events after
    const eventsBeforeBearer = await h.getEvents();

    // Fill in Bearer token via Playwright
    await fillBearerTokenViaPlaywright(paramsEvent.paramsCollectionUrl, ctx.impersonationCookies);
    console.log("Bearer token configured");

    // Wait for connection established (using events from BEFORE bearer was configured)
    await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeBearer, {
      timeout: 15_000,
    });
    console.log("MCP connection established (bearer)");

    // Ask the agent to use a tool
    const toolMsg = await h.sendUserMessage(
      `Using the MCP server, call mock_calculate with { operation: 'multiply', a: 7, b: 8 }. Return only the result.`,
    );

    const reply = await toolMsg.waitForReply({ timeout: 15_000 });
    expect(reply).toMatch(/56/);
    console.log("✅ Tool call successful (bearer)");
  });

  test(
    "refreshes OAuth token when expired and continues to work",
    { timeout: 3 * 60 * 1000 },
    async () => {
      const env = parseEnv();
      const serverUrl = env.MOCK_MCP_OAUTH_SERVER_URL;
      const tokenExpirySeconds = 60; // Cloudflare KV minimum TTL

      // Create a fresh user context for this test to avoid OAuth token conflicts
      // with other tests that use the same OAuth endpoint
      const { sessionCookies } = await getServiceAuthCredentials();
      const { user: tokenRefreshUser } = await ctx.adminTrpc.testing.createTestUser.mutate({});
      const { estate: _tokenRefreshEstate, organization: tokenRefreshOrg } =
        await ctx.adminTrpc.testing.createOrganizationAndEstate.mutate({
          userId: tokenRefreshUser.id,
        });
      const { trpcClient: tokenRefreshTrpc, impersonationCookies: tokenRefreshCookies } =
        await getImpersonatedTrpcClient({
          userId: tokenRefreshUser.id,
          adminSessionCookes: sessionCookies,
        });

      try {
        const h = await createTestHelper({
          trpcClient: tokenRefreshTrpc,
          inputSlug: "mcp-token-refresh",
          userId: tokenRefreshUser.id,
        });

        // Save events BEFORE sending the message
        const eventsBeforeMessage = await h.getEvents();

        // Ask the agent to connect to the MCP server
        await h.sendUserMessage(`Connect to the MCP server at ${serverUrl}. It uses OAuth.`);

        // Wait for OAuth required event (using events from BEFORE the message)
        const oauthEvent = await h.waitForEvent("MCP:OAUTH_REQUIRED", eventsBeforeMessage, {
          timeout: 15_000,
          select: (e: AgentEvent & { type: "MCP:OAUTH_REQUIRED" }) => e.data,
        });

        // Save events BEFORE completing OAuth
        const eventsBeforeOAuth = await h.getEvents();

        // Complete OAuth with short expiry
        await completeOAuthFlow(oauthEvent.oauthUrl, tokenRefreshCookies, tokenExpirySeconds);
        console.log(`Completed OAuth flow with ${tokenExpirySeconds}s token expiry`);

        // Wait for connection established (using events from BEFORE OAuth was completed)
        await h.waitForEvent("MCP:CONNECTION_ESTABLISHED", eventsBeforeOAuth, {
          timeout: 10_000,
        });
        console.log("MCP connection established");

        // First tool call - fresh token
        const firstMsg = await h.sendUserMessage(`Using the MCP server, call userInfo.`);
        const firstReply = await firstMsg.waitForReply({ timeout: 15_000 });
        expect(firstReply).toMatch(/user/i);
        console.log("✅ First tool call successful (fresh token)");

        // Wait for token to expire
        console.log(`Waiting ${tokenExpirySeconds + 10}s for token to expire...`);
        await new Promise((resolve) => setTimeout(resolve, (tokenExpirySeconds + 10) * 1000));

        // Second tool call - should trigger token refresh
        const secondMsg = await h.sendUserMessage(
          `Using the MCP server, call greet with formal=true.`,
        );
        // Give more time for token refresh flow
        const secondReply = await secondMsg.waitForReply({ timeout: 30_000 });
        expect(secondReply).toMatch(/good day|hello|greet/i);
        console.log("✅ Second tool call successful (token was refreshed)");
      } finally {
        // Cleanup the token refresh test user and organization
        await ctx.adminTrpc.testing.deleteOrganization.mutate({
          organizationId: tokenRefreshOrg.id,
        });
        await ctx.adminTrpc.admin.deleteUserByEmail.mutate({ email: tokenRefreshUser.email });
      }
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

  // Follow redirects back to our app
  const currentUrl = oauthResponse.headers.get("location");
  console.log("[OAuth] Step 4: Following redirects, first URL:", currentUrl);
  const _redirectCount = 0;

  // Only follow the callback redirect - after that, the token is saved
  // and we don't need to follow UI navigation redirects
  if (currentUrl) {
    const absoluteUrl = currentUrl.startsWith("http")
      ? currentUrl
      : `${process.env.VITE_PUBLIC_URL}${currentUrl}`;

    // Only follow the callback URL (contains /api/auth/integrations/callback)
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
  // Give the agent time to process
  await new Promise((resolve) => setTimeout(resolve, 2000));
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
    // Parse cookies and add them
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

    // Add request/response debugging
    page.on("request", (req) => console.log("[Bearer] Request:", req.method(), req.url()));
    page.on("response", (res) => console.log("[Bearer] Response:", res.status(), res.url()));
    page.on("requestfailed", (req) =>
      console.log("[Bearer] Request failed:", req.url(), req.failure()?.errorText),
    );
    page.on("console", (msg) => console.log("[Bearer] Console:", msg.type(), msg.text()));

    console.log("[Bearer] Navigating to:", paramsUrl);
    const response = await page.goto(paramsUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log("[Bearer] Page loaded, status:", response?.status(), "URL:", page.url());

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
