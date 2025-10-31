import { test, expect, vi } from "vitest";
import { z } from "zod/v4";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { makeVitestTrpcClient } from "./utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";

/**
 * End-to-End Mock MCP OAuth Tests
 *
 * These tests simulate OAuth flows with a mock MCP server.
 *
 * Prerequisites:
 * - mock.iterate.com MCP server must be running
 * - SERVICE_AUTH_TOKEN environment variable must be set
 */

// Environment variables schema
const TestEnv = z.object({
  VITE_PUBLIC_URL: z.string().url().default("http://localhost:5173"),
  SERVICE_AUTH_TOKEN: z.string().optional(),
  MOCK_MCP_SERVER_URL: z.string().url().default("https://mock.iterate.com/oauth/mcp"),
});

type TestEnv = z.infer<typeof TestEnv>;

// ============================================================================
// Helper Functions
// ============================================================================

interface AuthenticatedSession {
  sessionCookies: string;
  adminTrpc: ReturnType<typeof makeVitestTrpcClient>;
}

async function authenticateWithServiceAuth(env: TestEnv): Promise<AuthenticatedSession> {
  console.log("Authenticating with service auth token...");

  if (!env.SERVICE_AUTH_TOKEN) {
    throw new Error("SERVICE_AUTH_TOKEN environment variable is required");
  }

  const serviceAuthResponse = await fetch(
    `${env.VITE_PUBLIC_URL}/api/auth/service-auth/create-session`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serviceAuthToken: env.SERVICE_AUTH_TOKEN,
      }),
    },
  );

  if (!serviceAuthResponse.ok) {
    const error = await serviceAuthResponse.text();
    throw new Error(`Failed to authenticate with service auth: ${error}`);
  }

  const sessionCookies = serviceAuthResponse.headers.get("set-cookie");
  if (!sessionCookies) {
    throw new Error("Failed to get session cookies from service auth");
  }

  const adminTrpc = makeVitestTrpcClient({
    url: `${env.VITE_PUBLIC_URL}/api/trpc`,
    headers: {
      cookie: sessionCookies,
    },
  });

  console.log("Successfully authenticated");

  return { sessionCookies, adminTrpc };
}

interface TestUser {
  user: { id: string; email: string };
  organization: { id: string; name: string };
  estate: { id: string; name: string };
}

async function setupTestUser(
  adminTrpc: ReturnType<typeof makeVitestTrpcClient>,
): Promise<TestUser> {
  console.log("Setting up test user with organization and estate...");

  const testData = await adminTrpc.admin.setupTestOnboardingUser.mutate();
  if (!testData) {
    throw new Error("Failed to setup test user with organization and estate");
  }

  const { user, organization, estate } = testData;
  console.log(`Created test user: ${user.email} (${user.id})`);
  console.log(`Created organization: ${organization.name} (${organization.id})`);
  console.log(`Created estate: ${estate.name} (${estate.id})`);

  return { user, organization, estate };
}

interface ImpersonatedSession {
  impersonationCookies: string;
  userTrpc: ReturnType<typeof makeVitestTrpcClient>;
}

async function impersonateUser(
  env: TestEnv,
  sessionCookies: string,
  userId: string,
): Promise<ImpersonatedSession> {
  console.log("Impersonating test user...");

  const authClient = createAuthClient({
    baseURL: env.VITE_PUBLIC_URL,
    plugins: [adminClient()],
  });

  let impersonationCookies = "";

  const impersonationResult = await authClient.admin.impersonateUser(
    {
      userId,
    },
    {
      headers: {
        cookie: sessionCookies,
      },
      onResponse(context: { response: Response }) {
        const cookies = context.response.headers.getSetCookie();
        const cookieObj = Object.fromEntries(cookies.map((cookie) => cookie.split("=")));
        if (cookieObj) {
          impersonationCookies = Object.entries(cookieObj)
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
        }
      },
    },
  );

  if (!impersonationResult?.data) {
    throw new Error("Failed to impersonate user");
  }

  if (!impersonationCookies) {
    throw new Error("Failed to get impersonation cookies");
  }

  console.log("Successfully impersonated test user");

  const userTrpc = makeVitestTrpcClient({
    url: `${env.VITE_PUBLIC_URL}/api/trpc`,
    headers: {
      cookie: impersonationCookies,
    },
  });

  return { impersonationCookies, userTrpc };
}

async function createAgentInstance(
  userTrpc: ReturnType<typeof makeVitestTrpcClient>,
  estateId: string,
): Promise<string> {
  console.log("Creating agent instance...");

  const agentInstanceName = `test-agent-${Date.now()}`;

  await userTrpc.agents.getState.query({
    estateId,
    agentInstanceName,
    agentClassName: "IterateAgent",
    reason: "E2E Mock MCP OAuth Test",
  });

  console.log(`Agent instance created: ${agentInstanceName}`);

  return agentInstanceName;
}

interface MCPConnectionOptions {
  expiresIn?: number; // Token expiration time in seconds
}

async function initiateMCPConnection(
  env: TestEnv,
  userTrpc: ReturnType<typeof makeVitestTrpcClient>,
  estateId: string,
  agentInstanceName: string,
  userId: string,
  options?: MCPConnectionOptions,
): Promise<void> {
  console.log("Initiating MCP connection with OAuth...");

  const event: any = {
    type: "MCP:CONNECT_REQUEST",
    data: {
      serverUrl: env.MOCK_MCP_SERVER_URL,
      mode: "personal",
      userId,
      integrationSlug: "mock-mcp",
      triggerLLMRequestOnEstablishedConnection: false,
    },
  };

  // Add expiration parameter if provided
  if (options?.expiresIn !== undefined) {
    event.data.expiresIn = options.expiresIn;
  }

  await userTrpc.agents.addEvents.mutate({
    estateId,
    agentInstanceName,
    agentClassName: "IterateAgent",
    events: [event],
  });

  console.log("MCP connection request sent");
}

async function waitForOAuthUrl(
  env: TestEnv,
  userTrpc: ReturnType<typeof makeVitestTrpcClient>,
  estateId: string,
  agentInstanceName: string,
): Promise<string> {
  console.log("Waiting for OAuth URL...");

  let oauthUrl: string | null = null;

  await expect
    .poll(
      async () => {
        const state = await userTrpc.agents.getState.query({
          estateId,
          agentInstanceName,
          agentClassName: "IterateAgent",
        });

        const oauthEvent = state.events.find(
          (e: any) =>
            e.type === "MCP:OAUTH_REQUIRED" && e.data.serverUrl === env.MOCK_MCP_SERVER_URL,
        );

        if (oauthEvent) {
          oauthUrl = (oauthEvent as any).data.oauthUrl;
          return true;
        }

        return false;
      },
      {
        timeout: 30000,
        interval: 1000,
      },
    )
    .toBe(true);

  expect(oauthUrl).toBeTruthy();
  console.log(`OAuth URL received: ${oauthUrl}`);

  return oauthUrl!;
}

async function completeOAuthFlow(
  env: TestEnv,
  oauthUrl: string,
  impersonationCookies: string,
): Promise<void> {
  console.log("Completing OAuth flow...");

  console.log(`Fetching OAuth authorization URL...`);

  const redirectResponse = await fetch(oauthUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      cookie: impersonationCookies,
    },
  });

  expect(redirectResponse.status).toBeGreaterThanOrEqual(300);
  expect(redirectResponse.status).toBeLessThan(400);

  const authUrl = redirectResponse.headers.get("location");
  expect(authUrl).toBeTruthy();
  console.log(`Got OAuth authorization URL from mock server`);

  if (authUrl!.startsWith("/")) {
    throw new Error(
      `OAuth state not ready - got redirect to ${authUrl} instead of OAuth authorization URL. ` +
        `This usually means the MCP OAuth flow hasn't completed initialization.`,
    );
  }

  const authUrlObj = new URL(authUrl!);
  authUrlObj.searchParams.set("auto_approve", "true");
  console.log(`Authorizing with mock server (auto-approve)...`);

  const oauthResponse = await fetch(authUrlObj.toString(), {
    method: "GET",
    redirect: "manual",
  });

  expect(oauthResponse.status).toBeGreaterThanOrEqual(300);
  expect(oauthResponse.status).toBeLessThan(400);

  const callbackUrl = oauthResponse.headers.get("location");
  expect(callbackUrl).toBeTruthy();
  console.log(`Processing OAuth callback...`);

  let currentUrl = callbackUrl;
  let redirectCount = 0;
  const maxRedirects = 10;

  while (currentUrl && redirectCount < maxRedirects) {
    if (currentUrl.startsWith("/")) {
      currentUrl = `${env.VITE_PUBLIC_URL}${currentUrl}`;
    }

    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        cookie: impersonationCookies,
      },
    });

    if (response.status >= 300 && response.status < 400) {
      currentUrl = response.headers.get("location");
      redirectCount++;
    } else {
      break;
    }
  }

  if (redirectCount >= maxRedirects) {
    throw new Error("Hit max redirects limit during OAuth callback");
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

async function waitForConnectionEstablished(
  env: TestEnv,
  userTrpc: ReturnType<typeof makeVitestTrpcClient>,
  estateId: string,
  agentInstanceName: string,
): Promise<void> {
  console.log("Waiting for MCP connection to be established...");

  await expect
    .poll(
      async () => {
        const state = await userTrpc.agents.getState.query({
          estateId,
          agentInstanceName,
          agentClassName: "IterateAgent",
        });

        const connectedEvent = state.events.find(
          (e: any) =>
            e.type === "MCP:CONNECTION_ESTABLISHED" && e.data.serverUrl === env.MOCK_MCP_SERVER_URL,
        );

        return !!connectedEvent;
      },
      {
        timeout: 60000,
        interval: 2000,
      },
    )
    .toBe(true);

  console.log("✅ MCP connection established successfully!");
}

async function cleanupTestUser(
  adminTrpc: ReturnType<typeof makeVitestTrpcClient> | null,
  userEmail: string | null,
): Promise<void> {
  if (userEmail && adminTrpc) {
    console.log(`Cleaning up: Deleting user ${userEmail}...`);
    try {
      await adminTrpc.admin.deleteUserByEmail.mutate({ email: userEmail });
      console.log(`User ${userEmail} deleted successfully`);
    } catch (error) {
      console.error(`Failed to delete user: ${error}`);
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

test.skipIf(!process.env.VITEST_RUN_MOCK_MCP_TEST)(
  "end-to-end mock MCP OAuth flow",
  {
    timeout: 10 * 60 * 1000,
  },
  async () => {
    const env = TestEnv.parse({
      VITE_PUBLIC_URL: process.env.VITE_PUBLIC_URL,
      SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
      MOCK_MCP_SERVER_URL: process.env.MOCK_MCP_SERVER_URL,
    });

    let createdUserEmail: string | null = null;
    let adminTrpc: ReturnType<typeof makeVitestTrpcClient> | null = null;

    try {
      // Step 1: Authenticate
      console.log("Step 1: Authenticating with service auth token...");
      const { sessionCookies, adminTrpc: admin } = await authenticateWithServiceAuth(env);
      adminTrpc = admin;

      // Step 2: Setup test user
      console.log("Step 2: Setting up test user with organization and estate...");
      const { user, organization, estate } = await setupTestUser(adminTrpc);
      createdUserEmail = user.email;

      // Step 3: Impersonate user
      console.log("Step 3: Impersonating test user...");
      const { impersonationCookies, userTrpc } = await impersonateUser(
        env,
        sessionCookies,
        user.id,
      );

      // Step 4: Create agent
      console.log("Step 4: Creating agent instance...");
      const agentInstanceName = await createAgentInstance(userTrpc, estate.id);

      // Step 5: Initiate connection
      console.log("Step 5: Initiating MCP connection with OAuth...");
      await initiateMCPConnection(env, userTrpc, estate.id, agentInstanceName, user.id);

      // Step 6: Wait for OAuth URL
      console.log("Step 6: Waiting for OAuth URL...");
      const oauthUrl = await waitForOAuthUrl(env, userTrpc, estate.id, agentInstanceName);

      // Step 7: Complete OAuth flow
      console.log("Step 7: Completing OAuth flow...");
      await completeOAuthFlow(env, oauthUrl, impersonationCookies);

      // Step 8: Verify connection established
      console.log("Step 8: Waiting for MCP connection to be established...");
      await waitForConnectionEstablished(env, userTrpc, estate.id, agentInstanceName);

      console.log("✅ End-to-end Mock MCP OAuth test completed successfully!");
    } finally {
      await cleanupTestUser(adminTrpc, createdUserEmail);
    }
  },
);

test.skipIf(!process.env.VITEST_RUN_MOCK_MCP_TEST)(
  "MCP OAuth token refresh after expiration",
  {
    timeout: 2 * 60 * 1000, // 2 minutes
  },
  async () => {
    const env = TestEnv.parse({
      VITE_PUBLIC_URL: process.env.VITE_PUBLIC_URL,
      SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
      MOCK_MCP_SERVER_URL: process.env.MOCK_MCP_SERVER_URL,
    });

    let createdUserEmail: string | null = null;
    let adminTrpc: ReturnType<typeof makeVitestTrpcClient> | null = null;

    try {
      // Step 1: Authenticate
      console.log("Step 1: Authenticating with service auth token...");
      const { sessionCookies, adminTrpc: admin } = await authenticateWithServiceAuth(env);
      adminTrpc = admin;

      // Step 2: Setup test user
      console.log("Step 2: Setting up test user with organization and estate...");
      const { user, organization, estate } = await setupTestUser(adminTrpc);
      createdUserEmail = user.email;

      // Step 3: Impersonate user
      console.log("Step 3: Impersonating test user...");
      const { impersonationCookies, userTrpc } = await impersonateUser(
        env,
        sessionCookies,
        user.id,
      );

      // Step 4: Create agent
      console.log("Step 4: Creating agent instance...");
      const agentInstanceName = await createAgentInstance(userTrpc, estate.id);

      // Step 5: Initiate connection with 1-second token expiration
      console.log("Step 5: Initiating MCP connection with 1-second token expiration...");
      await initiateMCPConnection(env, userTrpc, estate.id, agentInstanceName, user.id, {
        expiresIn: 1, // Token expires in 1 second
      });

      // Step 6: Wait for OAuth URL
      console.log("Step 6: Waiting for OAuth URL...");
      const oauthUrl = await waitForOAuthUrl(env, userTrpc, estate.id, agentInstanceName);

      // Step 7: Complete OAuth flow
      console.log("Step 7: Completing OAuth flow...");
      await completeOAuthFlow(env, oauthUrl, impersonationCookies);

      // Step 8: Verify initial connection established
      console.log("Step 8: Waiting for initial MCP connection...");
      await waitForConnectionEstablished(env, userTrpc, estate.id, agentInstanceName);

      console.log("✅ Initial connection established with 1-second token expiration");

      // Step 9: Wait for 3 seconds to ensure token has expired and been refreshed
      console.log("Step 9: Waiting 3 seconds for token to expire and refresh...");

      await new Promise((resolve) => setTimeout(resolve, 3 * 1000)); // 3 seconds

      console.log("✅ Wait complete - token should have been refreshed");

      // Step 10: Verify connection is still active (token refresh should be transparent)
      console.log("Step 10: Verifying connection is still active after token refresh...");

      // Connection should still be established - refresh should be transparent
      await waitForConnectionEstablished(env, userTrpc, estate.id, agentInstanceName);

      const state = await userTrpc.agents.getState.query({
        estateId: estate.id,
        agentInstanceName,
        agentClassName: "IterateAgent",
      });

      // Check for connection events
      const connectionEvents = state.events.filter(
        (e: any) =>
          (e.type === "MCP:CONNECTION_ESTABLISHED" || e.type === "MCP:CONNECTION_CLOSED") &&
          e.data.serverUrl === env.MOCK_MCP_SERVER_URL,
      );

      const establishedCount = connectionEvents.filter(
        (e: any) => e.type === "MCP:CONNECTION_ESTABLISHED",
      ).length;
      const closedCount = connectionEvents.filter(
        (e: any) => e.type === "MCP:CONNECTION_CLOSED",
      ).length;

      console.log(`Connection events: ${establishedCount} established, ${closedCount} closed`);

      // Token refresh should be transparent - we should have:
      // 1. At least one established connection
      // 2. Zero or minimal closed events (no disconnection due to token expiry)
      expect(establishedCount).toBeGreaterThanOrEqual(1);
      expect(closedCount).toBe(0); // No disconnections means token refresh worked

      console.log("✅ Token refresh working correctly!");
      console.log("✅ Connection remained active after token expiration and refresh!");
    } finally {
      await cleanupTestUser(adminTrpc, createdUserEmail);
    }
  },
);
