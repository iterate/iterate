import { contextStorage } from "hono/context-storage";
import type {
  InternalCreateProjectForOrganizationInput,
  InternalIntrospectOAuthAccessTokenInput,
  ProjectInput,
} from "@iterate-com/auth-contract";
import type {
  MintProjectAppSessionInput,
  ValidateProjectAppSessionInput,
} from "@iterate-com/auth-contract/worker";
import { AuthWorker as AuthWorkerContract } from "@iterate-com/auth-contract/worker";
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
import { forwardableLoginHint } from "../lib/forwardable-login-hint.ts";
import { auth } from "./auth.ts";
import { resolveAllowedBrowserOrigin } from "./browser-origin.ts";
import { db } from "./db/index.ts";
import { config } from "./env.ts";
import { hono, variablesProvider, type Variables } from "./utils/hono.ts";
import { appRouter } from "./orpc/index.ts";
import type { CloudflareEnv } from "./env.ts";
import { appendSetCookieHeaders, resolveAuthLogoutReturnTo } from "./logout.ts";
import { makeAuthorizationResponseIssuerOptional } from "./oauth-metadata.ts";
import { introspectAccessToken } from "./oauth-token-introspection.ts";
import {
  mintProjectAppSession as mintProjectAppSessionToken,
  validateProjectAppSession as validateProjectAppSessionToken,
} from "./project-app-session.ts";
import {
  createProjectForOrganization,
  getProjectBySlug,
  listProjectsForUser,
  mintProjectId,
  userCanAccessProject,
} from "./project-directory.ts";
import { buildAccessTokenGrantClaims } from "./oauth-project-selection.ts";
import { getUserByEmail } from "./db/queries/index.ts";

const app = hono();
const AUTH_ISSUER_PATH = "/api/auth";

app.use(
  cors({
    origin: (origin) => {
      return resolveAllowedBrowserOrigin(origin, config);
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
  contextStorage(),
  variablesProvider(),
);

app.get("/api/auth/.well-known/openid-configuration", async (c) =>
  makeAuthorizationResponseIssuerOptional(await oauthProviderOpenIdConfigMetadata(auth)(c.req.raw)),
);
app.get(`/.well-known/openid-configuration${AUTH_ISSUER_PATH}`, async (c) =>
  makeAuthorizationResponseIssuerOptional(await oauthProviderOpenIdConfigMetadata(auth)(c.req.raw)),
);
app.get("/api/auth/.well-known/oauth-authorization-server", async (c) =>
  makeAuthorizationResponseIssuerOptional(await oauthProviderAuthServerMetadata(auth)(c.req.raw)),
);
app.get(`/.well-known/oauth-authorization-server${AUTH_ISSUER_PATH}`, async (c) =>
  makeAuthorizationResponseIssuerOptional(await oauthProviderAuthServerMetadata(auth)(c.req.raw)),
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
      authOrigin: config.authAppOrigin,
      publicOrigin: config.publicUrl,
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
  const requestUrl = new URL(request.url);
  const paramNames = [OAUTH_RESOURCE_PARAMETER];
  if (forwardableLoginHint(requestUrl.searchParams.get("login_hint"))) {
    paramNames.push("login_hint");
  }
  return preserveRedirectSearchParams(request, response, paramNames);
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

/**
 * Auth's default entrypoint serves public HTTP through `fetch`. Its other
 * public methods are RPC capabilities available only to workers that hold a
 * service binding to auth; public HTTP requests cannot select those methods.
 */
export default class AuthWorker extends AuthWorkerContract<CloudflareEnv> {
  override fetch(request: Request) {
    return app.fetch(request, this.env, this.ctx);
  }

  createProjectForOrganization(input: InternalCreateProjectForOrganizationInput) {
    return createProjectForOrganization(input, db);
  }

  getProjectBySlug(input: ProjectInput) {
    return getProjectBySlug(input, db);
  }

  listProjectsForUser(input: { userId: string }) {
    return listProjectsForUser(input, db);
  }

  async getUserGrants(input: { userId: string }) {
    // Reuse the single source of truth for "what a token grants": no scopes + no
    // selection => every organization and project this user can reach.
    const { organizations, projects } = await buildAccessTokenGrantClaims(
      { userId: input.userId, requestedScopes: [], selection: null },
      db,
    );
    return { organizations, projects };
  }

  async getUserGrantsByEmail(input: { email: string }) {
    // Resolve the verified email to a user, then the same grant bundle as getUserGrants.
    // Unknown email => empty grants (a caller behind a wall may present any email).
    const user = await getUserByEmail(db, { email: input.email.trim().toLowerCase() });
    if (!user) return { organizations: [], projects: [] };
    const { organizations, projects } = await buildAccessTokenGrantClaims(
      { userId: user.id, requestedScopes: [], selection: null },
      db,
    );
    return { organizations, projects };
  }

  mintProjectAppSession(input: MintProjectAppSessionInput) {
    return mintProjectAppSessionToken(input, projectAppSessionDependencies());
  }

  validateProjectAppSession(input: ValidateProjectAppSessionInput) {
    return validateProjectAppSessionToken(input, projectAppSessionDependencies());
  }

  mintProjectId() {
    return mintProjectId();
  }

  introspectAccessToken(input: InternalIntrospectOAuthAccessTokenInput) {
    return introspectAccessToken({
      input,
      client: db,
      issuer: `${config.authAppOrigin.replace(/\/+$/, "")}/api/auth`,
    });
  }
}

function projectAppSessionDependencies() {
  return {
    secret: (config.projectAppSessionSecret ?? config.betterAuthSecret).exposeSecret(),
    userCanAccessProject: (input: { projectId: string; userId: string }) =>
      userCanAccessProject(input, db),
  };
}
