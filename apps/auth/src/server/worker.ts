import { contextStorage } from "hono/context-storage";
import {
  oauthProviderOpenIdConfigMetadata,
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider";
import tanstackStartServerEntry from "@tanstack/react-start/server-entry";
import { cors } from "hono/cors";
import { RequestHeadersPlugin } from "@orpc/server/plugins";
import { onError, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { auth } from "./auth.ts";
import { hono, variablesProvider } from "./utils/hono.ts";
import { appRouter } from "./orpc/index.ts";

const app = hono();

app.use(
  contextStorage(),
  variablesProvider(),
  cors({
    origin: (origin) => origin,
  }),
);

app.get("/api/auth/.well-known/openid-configuration", (c) =>
  oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
);
app.get("/api/auth/.well-known/oauth-authorization-server", (c) =>
  oauthProviderAuthServerMetadata(auth)(c.req.raw),
);
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

export const orpcHandler = new RPCHandler(appRouter, {
  plugins: [new RequestHeadersPlugin()],
  interceptors: [
    onError((error) => {
      console.error(error);
      if (error instanceof ORPCError) return;
      throw error;
    }),
  ],
});

app.all("/api/orpc/*", async (c) => {
  const { matched, response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: { env: c.env, ...c.var },
  });

  if (!matched) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.newResponse(response.body, response);
});

app.all("*", (c) => tanstackStartServerEntry.fetch(c.req.raw));

export default app;
