import type { AuthenticatedSession, AuthenticateErrorEvent } from "@iterate-com/auth/server";
import {
  ItxAuthenticationError,
  itxAuthFromImpersonatedToken,
  itxAuthFromPrincipal,
  type ItxAuth,
  type ItxAuthCredentials,
} from "../auth.ts";
import type { AppConfig } from "../config.ts";
import { authenticateAdminApiSecret, authenticateAdminBearer } from "./admin.ts";
import type { SignInAuthError } from "./errors.ts";
import type { OsIterateAuth } from "./iterate-auth-client.ts";
import {
  authenticateOperatorSession,
  authenticateOperatorToken,
  isSameOriginBrowserRequest,
  type AuthenticatedOperatorSession,
} from "./operator-session.ts";
import { principalFromIdentity, type Principal } from "./principal.ts";

type FromRequestCredentials = { type: "from-request" };

type OsRequestAuthResolution = {
  /** Capability authority constructed from the proven identity, when any. */
  itxAuth: ItxAuth | null;
  principal: Principal | null;
  iterateAuthSession: AuthenticatedSession | null;
  operatorSession: AuthenticatedOperatorSession | null;
  error?: SignInAuthError;
  /** Headers produced by session refresh and required on the final response. */
  responseHeaders: Headers;
  /** Diagnostic detail kept server-side; never expose its throwable to a client. */
  sessionVerificationFailure?: AuthenticateErrorEvent;
};

type AuthenticatedOsRequestAuthResolution = Omit<OsRequestAuthResolution, "itxAuth"> & {
  itxAuth: ItxAuth;
};

type ResolveOsRequestAuthInput = {
  config: AppConfig;
  credentials: ItxAuthCredentials | FromRequestCredentials;
  iterateAuth: OsIterateAuth | null;
  request: Request;
};

/** Optional ambient HTTP authentication; an anonymous request is a valid result. */
export function resolveOsRequestAuth(
  input: ResolveOsRequestAuthInput & { credentials: FromRequestCredentials },
): Promise<OsRequestAuthResolution>;

/** Explicit Cap'n Web credentials are strict: invalid credentials reject. */
export function resolveOsRequestAuth(
  input: ResolveOsRequestAuthInput & { credentials: ItxAuthCredentials },
): Promise<AuthenticatedOsRequestAuthResolution>;

/**
 * The one OS credential resolver, shared by HTTP request middleware and the
 * unauthenticated Cap'n Web root. HTTP may remain anonymous; an explicit RPC
 * exchange either returns capability authority or throws
 * {@link ItxAuthenticationError}.
 */
export async function resolveOsRequestAuth(
  input: ResolveOsRequestAuthInput,
): Promise<OsRequestAuthResolution> {
  const { config, credentials, request } = input;

  if (credentials.type === "admin-secret") {
    const principal = authenticateAdminBearer({
      authorizationHeader: `Bearer ${credentials.secret}`,
      config,
    });
    if (!principal) throw new ItxAuthenticationError();
    return resolutionFromPrincipal(principal);
  }

  if (credentials.type === "operator-session") {
    const operatorSession = await authenticateOperatorToken({
      config,
      requestUrl: request.url,
      token: credentials.token,
    });
    if (!operatorSession) throw new ItxAuthenticationError();
    return resolutionFromOperatorSession(operatorSession);
  }

  if (credentials.type === "impersonate") {
    const principal = authenticateAdminBearer({
      authorizationHeader: `Bearer ${credentials.secret}`,
      config,
    });
    if (!principal) throw new ItxAuthenticationError();
    return {
      ...anonymousResolution(),
      itxAuth: itxAuthFromImpersonatedToken(credentials.token),
    };
  }

  if (credentials.type === "bearer") {
    const resolution = await resolveIterateCredential({
      accept: "bearer",
      auth: requireIterateAuth(input.iterateAuth),
      headers: new Headers({ authorization: `Bearer ${credentials.token}` }),
    });
    return requireAuthenticatedResolution(resolution);
  }

  if (credentials.type === "from-server-cookie") {
    // Ambient cookies are never authority on a cross-origin browser socket.
    // Browsers send Origin on WebSocket handshakes; non-browser clients should
    // use an explicit bearer/operator/admin credential instead.
    if (!isSameOriginBrowserRequest(request)) throw new ItxAuthenticationError();

    const operatorSession = await authenticateOperatorSession({ config, request });
    if (operatorSession) {
      return resolutionFromOperatorSession(operatorSession);
    }

    // An in-band RPC method cannot attach a rotated cookie to the outer
    // response. Authenticate the current cookie without refreshing it rather
    // than spending a refresh token that the browser can never receive.
    const resolution = await resolveIterateCredential({
      accept: "session",
      auth: requireIterateAuth(input.iterateAuth),
      headers: request.headers,
      refresh: "never",
    });
    return requireAuthenticatedResolution(resolution);
  }

  const adminPrincipal = authenticateAdminApiSecret({ config }, request);
  if (adminPrincipal) return resolutionFromPrincipal(adminPrincipal);

  // A short-lived operator session wins over the ordinary Iterate session so
  // an operator can open a narrowly-scoped browser without signing out first.
  const operatorSession = await authenticateOperatorSession({ config, request });
  if (operatorSession) {
    return resolutionFromOperatorSession(operatorSession);
  }

  if (!input.iterateAuth) return anonymousResolution();
  return await resolveIterateCredential({
    accept: "session-or-bearer",
    auth: input.iterateAuth,
    headers: request.headers,
  });
}

async function resolveIterateCredential(input: {
  accept: "session-or-bearer" | "session" | "bearer";
  auth: OsIterateAuth;
  headers: Headers;
  refresh?: "if-needed" | "never";
}): Promise<OsRequestAuthResolution> {
  const authenticationFailure: { event?: AuthenticateErrorEvent } = {};
  const authentication = await input.auth.authenticate({
    accept: input.accept,
    headers: input.headers,
    includeUserInfo: false,
    onError: (event) => {
      authenticationFailure.event = event;
    },
    refresh: input.refresh,
  });
  const authenticationError =
    authentication.credential === "session" ? undefined : authenticationFailure.event;
  const diagnostics: Pick<OsRequestAuthResolution, "error" | "sessionVerificationFailure"> =
    authenticationError
      ? {
          error: "session_verification_failed",
          sessionVerificationFailure: authenticationError,
        }
      : {};

  if (authentication.credential === null) {
    return { ...anonymousResolution(authentication.responseHeaders), ...diagnostics };
  }
  return resolutionFromPrincipal(principalFromIdentity(authentication.identity), {
    ...diagnostics,
    iterateAuthSession:
      authentication.credential === "session" ? authentication.session : undefined,
    responseHeaders: authentication.responseHeaders,
  });
}

function resolutionFromOperatorSession(
  operatorSession: AuthenticatedOperatorSession,
): AuthenticatedOsRequestAuthResolution {
  return resolutionFromPrincipal(operatorSession.principal, {
    allowDirectoryFallback: false,
    operatorSession,
  });
}

function requireAuthenticatedResolution(
  resolution: OsRequestAuthResolution,
): AuthenticatedOsRequestAuthResolution {
  if (!resolution.itxAuth) throw new ItxAuthenticationError();
  return { ...resolution, itxAuth: resolution.itxAuth };
}

function resolutionFromPrincipal(
  principal: Principal,
  details: {
    allowDirectoryFallback?: boolean;
    error?: SignInAuthError;
    iterateAuthSession?: AuthenticatedSession;
    operatorSession?: AuthenticatedOperatorSession;
    responseHeaders?: Headers;
    sessionVerificationFailure?: AuthenticateErrorEvent;
  } = {},
): AuthenticatedOsRequestAuthResolution {
  return {
    itxAuth: itxAuthFromPrincipal(principal, {
      allowDirectoryFallback: details.allowDirectoryFallback,
    }),
    principal,
    iterateAuthSession: details.iterateAuthSession ?? null,
    operatorSession: details.operatorSession ?? null,
    responseHeaders: details.responseHeaders ?? new Headers(),
    ...(details.error ? { error: details.error } : {}),
    ...(details.sessionVerificationFailure
      ? { sessionVerificationFailure: details.sessionVerificationFailure }
      : {}),
  };
}

function anonymousResolution(responseHeaders = new Headers()): OsRequestAuthResolution {
  return {
    itxAuth: null,
    principal: null,
    iterateAuthSession: null,
    operatorSession: null,
    responseHeaders,
  };
}

function requireIterateAuth(auth: OsIterateAuth | null): OsIterateAuth {
  if (!auth) throw new Error("iterate auth is not configured");
  return auth;
}
