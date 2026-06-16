import { contextStorage } from "hono/context-storage";
import {
  OAUTH_RESOURCE_PARAMETER,
  copyMissingSearchParams,
} from "@iterate-com/shared/oauth-resource";
import {
  oauthProviderOpenIdConfigMetadata,
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider";
import tanstackStartServerEntry from "@tanstack/react-start/server-entry";
import { cors } from "hono/cors";
import { RequestHeadersPlugin } from "@orpc/server/plugins";
import { onError, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { auth, getAllowedBrowserOrigins } from "./auth.ts";
import { hono, variablesProvider, type Variables } from "./utils/hono.ts";
import { appRouter } from "./orpc/index.ts";
import type { CloudflareEnv } from "./env.ts";
import { appendSetCookieHeaders, resolveAuthLogoutReturnTo } from "./logout.ts";

const app = hono();
const allowedBrowserOrigins = new Set(getAllowedBrowserOrigins());
const AUTH_ISSUER_PATH = "/api/auth";

app.use(
  cors({
    origin: (origin) => {
      if (!origin || !URL.canParse(origin)) return null;
      const normalizedOrigin = new URL(origin).origin;
      return allowedBrowserOrigins.has(normalizedOrigin) ? normalizedOrigin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
  contextStorage(),
  variablesProvider(),
);

app.get("/api/auth/.well-known/openid-configuration", (c) =>
  oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
);
app.get(`/.well-known/openid-configuration${AUTH_ISSUER_PATH}`, (c) =>
  oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
);
app.get("/api/auth/.well-known/oauth-authorization-server", (c) =>
  oauthProviderAuthServerMetadata(auth)(c.req.raw),
);
app.get(`/.well-known/oauth-authorization-server${AUTH_ISSUER_PATH}`, (c) =>
  oauthProviderAuthServerMetadata(auth)(c.req.raw),
);
app.all("/api/auth/oauth2/authorize", async (c) =>
  preserveOAuthResourceRedirect(c.req.raw, await auth.handler(c.req.raw)),
);
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/logout", async (c) => {
  const signOutUrl = new URL("/api/auth/sign-out", c.req.url);
  const signOutResponse = await auth.handler(
    new Request(signOutUrl, {
      method: "POST",
      headers: c.req.raw.headers,
    }),
  );
  const response = c.redirect(
    resolveAuthLogoutReturnTo({
      rawReturnTo: c.req.query("return_to"),
      authOrigin: c.env.VITE_AUTH_APP_ORIGIN,
      publicOrigin: c.env.VITE_PUBLIC_URL,
    }),
  );
  appendSetCookieHeaders(response.headers, signOutResponse.headers);
  return response;
});

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

type RequestContext = {
  cloudflare: {
    env: CloudflareEnv;
    ctx: ExecutionContext<unknown>;
  };
  variables: Variables;
};

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: RequestContext;
    };
  }
}

app.all("*", (c) =>
  tanstackStartServerEntry.fetch(c.req.raw, {
    context: {
      cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext<unknown> },
      variables: c.var,
    },
  }),
);

export function preserveOAuthResourceRedirect(request: Request, response: Response) {
  return preserveRedirectSearchParams(request, response, [OAUTH_RESOURCE_PARAMETER]);
}

function preserveRedirectSearchParams(
  request: Request,
  response: Response,
  paramNames: Iterable<string>,
) {
  if (response.status < 300 || response.status >= 400) return response;

  const requestUrl = new URL(request.url);
  const location = response.headers.get("Location");
  if (!location) return response;

  const redirectUrl = copyMissingSearchParams({
    targetUrl: location,
    sourceSearch: requestUrl.searchParams,
    paramNames,
    baseUrl: requestUrl,
  });
  const originalRedirectUrl = new URL(location, requestUrl);
  if (redirectUrl.href === originalRedirectUrl.href) return response;

  const headers = new Headers(response.headers);
  headers.set(
    "Location",
    location.startsWith("/") ? `${redirectUrl.pathname}${redirectUrl.search}` : redirectUrl.href,
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default app;
