import { Hono } from "hono";
import { createIterateAuth, withAuthenticationResponseHeaders } from "@iterate-com/auth/server";

let authClient: ReturnType<typeof createIterateAuth> | undefined;

function authFromEnv(env: Cloudflare.Env) {
  return (authClient ??= createIterateAuth({
    clientId: env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID,
    clientSecret: env.APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET,
    redirectURI: env.APP_CONFIG_ITERATE_AUTH__REDIRECT_URI,
    issuer: env.APP_CONFIG_ITERATE_AUTH__ISSUER,
  }));
}

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.get("/api/protected", async (c) => {
  const { session, responseHeaders } = await authFromEnv(c.env).authenticateSession({
    headers: c.req.raw.headers,
  });
  const response = session
    ? new Response(`Protected route accessed by ${session.user.email}`)
    : c.text("Unauthorized", 401);
  return withAuthenticationResponseHeaders(response, responseHeaders);
});

export default {
  async fetch(request: Request, env: Cloudflare.Env, executionContext: ExecutionContext) {
    const authResponse = await authFromEnv(env).fetch(request);
    return authResponse ?? app.fetch(request, env, executionContext);
  },
};
