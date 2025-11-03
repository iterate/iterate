import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import type { Env } from "./env.ts";
import { generateAutoUser, getOrCreateUser, type MockUser } from "./user-storage.ts";
import { renderConsentPage } from "./pages/consent.ts";
import { renderDocsPage } from "./pages/docs.ts";

interface MockOAuthSession {
  userId: string;
  userName: string;
  email: string;
  sessionId: string;
}

type HonoContext = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };
const app = new Hono<HonoContext>();

app.get("/guide", async (c) => {
  return c.html(renderDocsPage(c.req.url));
});

app.get("/oauth/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;

  if (!clientId) {
    return c.text("Invalid OAuth request: missing client_id", 400);
  }

  const url = new URL(c.req.url);
  const autoApprove = url.searchParams.get("auto_approve") === "true";
  const autoApproveEmail = url.searchParams.get("auto_approve_email");
  const autoApprovePassword = url.searchParams.get("auto_approve_password");
  const expiresIn = url.searchParams.get("expires_in");

  if (autoApprove || (autoApproveEmail && autoApprovePassword)) {
    let session: MockOAuthSession;

    if (autoApproveEmail && autoApprovePassword) {
      try {
        const user = await getOrCreateUser(c.env.OAUTH_KV, autoApproveEmail, autoApprovePassword);
        session = userToSession(user);
      } catch (error) {
        return c.text(
          `Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          401,
        );
      }
    } else {
      const autoUser = generateAutoUser();
      session = {
        userId: autoUser.userId,
        userName: autoUser.userName,
        email: autoUser.email,
        sessionId: `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      };
    }

    return completeAuthorizationFlow(c, oauthReqInfo, session, expiresIn);
  }

  return c.html(renderConsentPage(c.req.url, clientId));
});

app.post("/oauth/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;

  if (!clientId) {
    return c.text("Invalid OAuth request: missing client_id", 400);
  }

  const formData = await c.req.formData();
  const action = formData.get("action") as string;
  const url = new URL(c.req.url);
  const expiresIn = url.searchParams.get("expires_in");

  let session: MockOAuthSession;

  if (action === "auto") {
    const autoUser = generateAutoUser();
    session = {
      userId: autoUser.userId,
      userName: autoUser.userName,
      email: autoUser.email,
      sessionId: `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    };
  } else if (action === "login") {
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;

    if (!email || !password) {
      return c.text("Email and password are required", 400);
    }

    try {
      const user = await getOrCreateUser(c.env.OAUTH_KV, email, password);
      session = userToSession(user);
    } catch (error) {
      return c.html(
        renderConsentPage(
          c.req.url,
          clientId,
          `Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
        401,
      );
    }
  } else {
    return c.text("Invalid action", 400);
  }

  return completeAuthorizationFlow(c, oauthReqInfo, session, expiresIn);
});

async function completeAuthorizationFlow(
  c: Context<HonoContext>,
  oauthReqInfo: AuthRequest,
  session: MockOAuthSession,
  expiresIn: string | null,
) {
  const expiresInSeconds = Number(expiresIn);
  const authOptions = {
    request: oauthReqInfo,
    userId: session.userId,
    scope: oauthReqInfo.scope,
    props: {
      userId: session.userId,
      userName: session.userName,
      email: session.email,
      sessionId: session.sessionId,
      accessToken: `mock-token-${session.userId}`,
    },
    metadata: {
      label: session.userName,
    },
    ...(expiresInSeconds && { expiresIn: expiresInSeconds }),
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization(authOptions);

  return Response.redirect(redirectTo);
}

function userToSession(user: MockUser): MockOAuthSession {
  return {
    userId: user.userId,
    userName: user.userName,
    email: user.email,
    sessionId: `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  };
}

export { app as MockOAuthHandler };
