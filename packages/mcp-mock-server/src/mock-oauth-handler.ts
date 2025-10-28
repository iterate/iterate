import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import type { Env } from "./env.ts";

interface MockOAuthSession {
  userId: string;
  userName: string;
  email: string;
}

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/oauth/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;

  if (!clientId) {
    return c.text("Invalid OAuth request: missing client_id", 400);
  }

  const session = generateMockSession();
  return completeAuthorizationFlow(c, oauthReqInfo, session);
});

async function completeAuthorizationFlow(
  c: Context,
  oauthReqInfo: AuthRequest,
  session: MockOAuthSession,
) {
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

  return Response.redirect(redirectTo);
}

function generateMockSession(): MockOAuthSession {
  const id = `auto-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  return {
    userId: `mock-user-${id}`,
    userName: "Mock Test User",
    email: `mock-${id}@example.com`,
  };
}

export { app as MockOAuthHandler };
