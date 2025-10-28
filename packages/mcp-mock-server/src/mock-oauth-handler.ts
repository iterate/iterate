import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import type { Env } from "./env.ts";

/**
 * Mock OAuth Session
 */
interface MockOAuthSession {
  userId: string;
  userName: string;
  email: string;
}

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

/**
 * OAuth Authorize Endpoint
 *
 * Always auto-approves with auto-generated mock user.
 * No manual approval or pre-configuration needed!
 */
app.get("/oauth/authorize", async (c) => {
  console.log(`[OAuth Handler] Authorize endpoint called`);
  console.log(`[OAuth Handler] Query params:`, Object.fromEntries(new URL(c.req.url).searchParams));

  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;

  console.log(`[OAuth Handler] Parsed OAuth request:`, {
    clientId,
    redirectUri: oauthReqInfo.redirectUri,
    scope: oauthReqInfo.scope,
  });

  if (!clientId) {
    console.log(`[OAuth Handler] ERROR: Missing client_id`);
    return c.text("Invalid OAuth request: missing client_id", 400);
  }

  // Auto-generate a mock user
  const session = generateMockSession();

  console.log(`[OAuth Handler] Auto-approving with user:`, {
    userId: session.userId,
    userName: session.userName,
    email: session.email,
  });

  return completeAuthorizationFlow(c, oauthReqInfo, session);
});

/**
 * Complete the authorization flow and redirect back to client
 */
async function completeAuthorizationFlow(
  c: Context,
  oauthReqInfo: AuthRequest,
  session: MockOAuthSession,
) {
  console.log(`[OAuth Handler] Completing authorization for user: ${session.userId}`);

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: session.userId,
    scope: oauthReqInfo.scope,
    props: {
      userId: session.userId,
      userName: session.userName,
      email: session.email,
      accessToken: `mock-token-${session.userId}`,
    },
    metadata: {
      label: session.userName,
    },
  });

  console.log(`[OAuth Handler] Redirecting to: ${redirectTo}`);
  return Response.redirect(redirectTo);
}

/**
 * Generate a mock session for testing
 */
function generateMockSession(): MockOAuthSession {
  const id = `auto-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  return {
    userId: `mock-user-${id}`,
    userName: "Mock Test User",
    email: `mock-${id}@example.com`,
  };
}

export { app as MockOAuthHandler };
