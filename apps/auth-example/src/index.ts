import { serve } from "bun";
import { createIterateAuth } from "@iterate-com/auth/server";
import indexHtml from "./index.html";

export const auth = createIterateAuth({
  clientId: process.env.ITERATE_OAUTH_CLIENT_ID!,
  clientSecret: process.env.ITERATE_OAUTH_CLIENT_SECRET!,
  redirectURI: process.env.ITERATE_OAUTH_REDIRECT_URI!,
  issuer: process.env.ITERATE_OAUTH_ISSUER!,
});

serve({
  routes: {
    "/": indexHtml,
    "/api/iterate-auth/*": auth.handler,
    "/api/protected": async (req) => {
      const { session, responseHeaders } = await auth.authenticate({ headers: req.headers });
      if (!session) return new Response("Unauthorized", { status: 401 });
      return new Response(`Protected route accessed by ${session.user.email}`, {
        status: 200,
        headers: responseHeaders,
      });
    },
  },
  port: process.env.PORT ? Number(process.env.PORT) : 7001,
  development: process.env.NODE_ENV !== "production",
});
