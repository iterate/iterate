import { Hono } from "hono";
import { createIterateAuth } from "@iterate-com/auth/server";

function authFromEnv(env: Cloudflare.Env) {
  return createIterateAuth({
    clientId: env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID,
    clientSecret: env.APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET,
    redirectURI: env.APP_CONFIG_ITERATE_AUTH__REDIRECT_URI,
    issuer: env.APP_CONFIG_ITERATE_AUTH__ISSUER,
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
