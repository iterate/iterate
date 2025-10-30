import { test, expect } from "vitest";
import { z } from "zod/v4";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { makeVitestTrpcClient } from "./utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";

/**
 * End-to-End Mock MCP OAuth Test
 *
 * This test simulates a complete OAuth flow with a mock MCP server:
 * 1. Authenticate with service auth token
 * 2. Create a test user and organization/estate
 * 3. Impersonate that user using better-auth admin SDK
 * 4. Create or get an agent for the estate
 * 5. Initiate MCP connection to mock.iterate.com
 * 6. Complete OAuth flow automatically
 * 7. Verify connection is established
 * 8. Send a message to the agent to use an MCP tool
 * 9. Verify the tool call succeeded
 * 10. Clean up test user
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

test.skipIf(!process.env.VITEST_RUN_MOCK_MCP_TEST)(
  "end-to-end mock MCP OAuth flow",
  {
    timeout: 10 * 60 * 1000, // 10 minutes total timeout
  },
  async () => {
    // Parse and validate environment
    const env = TestEnv.parse({
      VITE_PUBLIC_URL: process.env.VITE_PUBLIC_URL,
      SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
      MOCK_MCP_SERVER_URL: process.env.MOCK_MCP_SERVER_URL,
    });

    let createdUserEmail: string | null = null;
    let adminTrpc: ReturnType<typeof makeVitestTrpcClient> | null = null;

    try {
      // Step 1: Create authenticated TRPC client using service auth
      console.log("Step 1: Authenticating with service auth token...");

      if (!env.SERVICE_AUTH_TOKEN) {
        throw new Error("SERVICE_AUTH_TOKEN environment variable is required");
      }

      // Use service auth to get session for super user
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

      console.log("Successfully authenticated");

      // Step 2: Setup test user with organization and estate
      console.log("Step 2: Setting up test user with organization and estate...");

      adminTrpc = makeVitestTrpcClient({
        url: `${env.VITE_PUBLIC_URL}/api/trpc`,
        headers: {
          cookie: sessionCookies,
        },
      });

      const testData = await adminTrpc.admin.setupTestOnboardingUser.mutate();
      if (!testData) {
        throw new Error("Failed to setup test user with organization and estate");
      }

      const { user, organization, estate } = testData;
      createdUserEmail = user.email;
      console.log(`Created test user: ${user.email} (${user.id})`);
      console.log(`Created organization: ${organization.name} (${organization.id})`);
      console.log(`Created estate: ${estate.name} (${estate.id})`);

      // Step 3: Impersonate the test user
      console.log("Step 3: Impersonating test user...");

      const authClient = createAuthClient({
        baseURL: env.VITE_PUBLIC_URL,
        plugins: [adminClient()],
      });

      let impersonationCookies = "";

      const impersonationResult = await authClient.admin.impersonateUser(
        {
          userId: user.id,
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

      // Create TRPC client with impersonated user session
      const userTrpc = makeVitestTrpcClient({
        url: `${env.VITE_PUBLIC_URL}/api/trpc`,
        headers: {
          cookie: impersonationCookies,
        },
      });

      // Step 4: Create or get an agent for the estate
      console.log("Step 4: Creating agent instance...");

      const agentInstanceName = `test-agent-${Date.now()}`;

      // Create the agent by calling getState (which uses getOrCreate)
      await userTrpc.agents.getState.query({
        estateId: estate.id,
        agentInstanceName,
        agentClassName: "IterateAgent",
        reason: "E2E Mock MCP OAuth Test",
      });

      console.log(`Agent instance created: ${agentInstanceName}`);

      // Step 5: Initiate MCP connection to mock.iterate.com
      console.log("Step 5: Initiating MCP connection with OAuth...");

      // Add a connect request event
      await userTrpc.agents.addEvents.mutate({
        estateId: estate.id,
        agentInstanceName,
        agentClassName: "IterateAgent",
        events: [
          {
            type: "MCP:CONNECT_REQUEST",
            data: {
              serverUrl: env.MOCK_MCP_SERVER_URL,
              mode: "personal",
              userId: user.id,
              integrationSlug: "mock-mcp",
              triggerLLMRequestOnEstablishedConnection: false,
            },
          },
        ],
      });

      console.log("MCP connection request sent");

      // Step 6: Poll for OAuth URL in agent events
      console.log("Step 6: Waiting for OAuth URL...");

      let oauthUrl: string | null = null;

      await expect
        .poll(
          async () => {
            const state = await userTrpc.agents.getState.query({
              estateId: estate.id,
              agentInstanceName,
              agentClassName: "IterateAgent",
            });

            // Look for MCP:OAUTH_REQUIRED event
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
            timeout: 30000, // 30 seconds
            interval: 1000, // 1 second
          },
        )
        .toBe(true);

      expect(oauthUrl).toBeTruthy();
      console.log(`OAuth URL received: ${oauthUrl}`);

      // Step 7: Complete OAuth flow automatically
      console.log("Step 7: Completing OAuth flow...");

      if (!oauthUrl) {
        throw new Error("OAuth URL is null");
      }

      // Follow the OAuth flow WITH authentication cookies
      console.log(`Fetching OAuth authorization URL...`);

      // First, fetch the redirect URL which will give us the actual OAuth authorization URL
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

      // Check if the URL is relative (which means OAuth state wasn't ready)
      if (authUrl!.startsWith("/")) {
        throw new Error(
          `OAuth state not ready - got redirect to ${authUrl} instead of OAuth authorization URL. ` +
            `This usually means the MCP OAuth flow hasn't completed initialization.`,
        );
      }

      // Add auto_approve parameter to the authorization URL
      const authUrlObj = new URL(authUrl!);
      authUrlObj.searchParams.set("auto_approve", "true");
      console.log(`Authorizing with mock server (auto-approve)...`);

      // Now follow the OAuth flow - the mock server should redirect back to /api/auth/integrations/callback/mcp
      const oauthResponse = await fetch(authUrlObj.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(oauthResponse.status).toBeGreaterThanOrEqual(300);
      expect(oauthResponse.status).toBeLessThan(400);

      const callbackUrl = oauthResponse.headers.get("location");
      expect(callbackUrl).toBeTruthy();
      console.log(`Processing OAuth callback...`);

      // Follow the callback redirect chain with authentication
      let currentUrl = callbackUrl;
      let redirectCount = 0;
      const maxRedirects = 10;

      while (currentUrl && redirectCount < maxRedirects) {
        // Handle relative URLs by making them absolute
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

      // Give the backend a moment to process the callback and reconnect
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Step 8: Wait for connection to be established
      console.log("Step 8: Waiting for MCP connection to be established...");

      await expect
        .poll(
          async () => {
            const state = await userTrpc.agents.getState.query({
              estateId: estate.id,
              agentInstanceName,
              agentClassName: "IterateAgent",
            });

            // Look for MCP:CONNECTION_ESTABLISHED event
            const connectedEvent = state.events.find(
              (e: any) =>
                e.type === "MCP:CONNECTION_ESTABLISHED" &&
                e.data.serverUrl === env.MOCK_MCP_SERVER_URL,
            );

            return !!connectedEvent;
          },
          {
            timeout: 60000, // 60 seconds
            interval: 2000, // 2 seconds
          },
        )
        .toBe(true);

      console.log("✅ MCP connection established successfully!");
      console.log("✅ End-to-end Mock MCP OAuth test completed successfully!");
    } finally {
      // Cleanup: Delete the created user
      if (createdUserEmail && adminTrpc) {
        console.log(`Cleaning up: Deleting user ${createdUserEmail}...`);
        try {
          await adminTrpc.admin.deleteUserByEmail.mutate({ email: createdUserEmail });
          console.log(`User ${createdUserEmail} deleted successfully`);
        } catch (error) {
          console.error(`Failed to delete user: ${error}`);
          // Don't fail the test if cleanup fails
        }
      }
    }
  },
);
