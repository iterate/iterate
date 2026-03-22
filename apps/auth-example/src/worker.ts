import { Hono } from "hono";
import { createIterateAuth } from "@iterate-com/auth/server";

function authFromEnv(env: Cloudflare.Env) {
  return createIterateAuth({
    clientId: env.ITERATE_OAUTH_CLIENT_ID,
    clientSecret: env.ITERATE_OAUTH_CLIENT_SECRET,
    redirectURI: env.ITERATE_OAUTH_REDIRECT_URI,
    issuer: env.ITERATE_OAUTH_ISSUER,
  });
}

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.all("/api/iterate-auth/*", (c) => authFromEnv(c.env).handler(c.req.raw));

app.get("/api/protected", async (c) => {
  const { session, responseHeaders } = await authFromEnv(c.env).authenticate({
    headers: c.req.raw.headers,
  });
  if (!session) {
    return c.text("Unauthorized", 401);
  }
  return new Response(`Protected route accessed by ${session.user.email}`, {
    status: 200,
    headers: responseHeaders,
  });
});

export default app;
