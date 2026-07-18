import { describe, expect, it, vi } from "vitest";
import {
  identityFromAccessToken,
  identityFromSession,
  type AuthenticatedSession,
  type Authentication,
  type AuthenticationOptions,
} from "@iterate-com/auth/server";
import { parseAppConfigFromEnv } from "@iterate-com/shared/config";
import type { OsIterateAuth } from "~/auth/iterate-auth-client.ts";
import { resolveOsRequestAuth } from "~/auth/request-auth.ts";
import { AppConfig } from "~/config.ts";

const ORIGIN = "https://os.example.test";
const ADMIN_SECRET = "request-auth-test-admin-secret";

function config() {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    env: {
      APP_CONFIG: JSON.stringify({ openAiApiKey: "test-openai-key" }),
      APP_CONFIG_ADMIN_API_SECRET: ADMIN_SECRET,
    },
    prefix: "APP_CONFIG_",
  });
}

function fakeIterateAuth(
  implementation: (options: AuthenticationOptions) => Promise<Authentication>,
) {
  const authenticate = vi.fn(implementation);
  const auth = {
    authHandlerBasePath: "/api/iterate-auth",
    authenticate,
    fetch: async () => null,
  } satisfies OsIterateAuth;
  return { auth, authenticate };
}

function session(): AuthenticatedSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    session: {
      activeOrganizationId: "org_one",
      expiresAt: now + 300,
      organizations: [{ id: "org_one", name: "One", role: "owner", slug: "one" }],
      projects: [{ id: "prj_one", organizationId: "org_one", slug: "one" }],
      scope: "openid profile email",
      sessionId: "ses_one",
    },
    tokenClaims: {
      accessToken: {
        aud: ORIGIN,
        exp: now + 300,
        iat: now,
        iss: "https://auth.example.test/api/auth",
        scope: "openid profile email",
        sub: "usr_one",
      },
      idToken: {
        aud: "os-test",
        email: "one@example.test",
        exp: now + 300,
        iat: now,
        iss: "https://auth.example.test/api/auth",
        sub: "usr_one",
      },
    },
    user: {
      email: "one@example.test",
      id: "usr_one",
    },
  };
}

describe("OS request authentication", () => {
  it("gives the deployment admin secret precedence without invoking Iterate auth", async () => {
    const { auth, authenticate } = fakeIterateAuth(async () => {
      throw new Error("Iterate auth must not run for the admin lane");
    });

    const resolution = await resolveOsRequestAuth({
      config: config(),
      credentials: { type: "from-request" },
      iterateAuth: auth,
      request: new Request(`${ORIGIN}/api`, {
        headers: { authorization: `Bearer ${ADMIN_SECRET}` },
      }),
    });

    expect(authenticate).not.toHaveBeenCalled();
    expect(resolution.principal).toEqual({ type: "admin" });
    expect(resolution.itxAuth?.isAdmin()).toBe(true);
  });

  it("resolves an HTTP session once and carries its rotated response headers", async () => {
    const authenticatedSession = session();
    const responseHeaders = new Headers({ "set-cookie": "iterate_session=rotated; Path=/" });
    const { auth, authenticate } = fakeIterateAuth(async () => ({
      credential: "session",
      identity: identityFromSession(authenticatedSession),
      responseHeaders,
      session: authenticatedSession,
    }));

    const resolution = await resolveOsRequestAuth({
      config: config(),
      credentials: { type: "from-request" },
      iterateAuth: auth,
      request: new Request(`${ORIGIN}/projects/one`, {
        headers: { cookie: "iterate_session=old" },
      }),
    });

    expect(authenticate).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        accept: "session-or-bearer",
        includeUserInfo: false,
      }),
    );
    expect(resolution.iterateAuthSession).toBe(authenticatedSession);
    expect(resolution.principal).toMatchObject({ type: "user", userId: "usr_one" });
    expect(resolution.itxAuth?.canAccessProject("prj_one")).toBe(true);
    expect(resolution.responseHeaders).toBe(responseHeaders);
  });

  it("never rotates cookies inside Cap'n Web authentication", async () => {
    const authenticatedSession = session();
    const { auth, authenticate } = fakeIterateAuth(async () => ({
      credential: "session",
      identity: identityFromSession(authenticatedSession),
      responseHeaders: new Headers(),
      session: authenticatedSession,
    }));

    const resolution = await resolveOsRequestAuth({
      config: config(),
      credentials: { type: "from-server-cookie" },
      iterateAuth: auth,
      request: new Request(`${ORIGIN}/api`, {
        headers: {
          cookie: "iterate_session=current",
          origin: ORIGIN,
        },
      }),
    });

    expect(resolution.itxAuth.canAccessProject("prj_one")).toBe(true);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ accept: "session", refresh: "never" }),
    );
  });

  it("preserves a session failure diagnostic when a bearer credential succeeds", async () => {
    const authenticatedSession = session();
    const failure = new Error("bad cookie signature");
    const { auth } = fakeIterateAuth(async (options) => {
      options.onError?.({ error: failure, reason: "access_token_verify_failed" });
      return {
        accessToken: authenticatedSession.tokenClaims.accessToken,
        credential: "bearer",
        identity: identityFromAccessToken(authenticatedSession.tokenClaims.accessToken),
        responseHeaders: new Headers(),
      };
    });

    const resolution = await resolveOsRequestAuth({
      config: config(),
      credentials: { type: "from-request" },
      iterateAuth: auth,
      request: new Request(`${ORIGIN}/api`, {
        headers: {
          authorization: "Bearer usable",
          cookie: "iterate_session=broken",
        },
      }),
    });

    expect(resolution.principal).toMatchObject({ type: "user", userId: "usr_one" });
    expect(resolution.error).toBe("session_verification_failed");
    expect(resolution.sessionVerificationFailure).toEqual({
      error: failure,
      reason: "access_token_verify_failed",
    });
  });

  it("allows an anonymous HTTP request but rejects an invalid explicit bearer", async () => {
    const { auth } = fakeIterateAuth(async () => ({
      credential: null,
      responseHeaders: new Headers(),
    }));

    const anonymous = await resolveOsRequestAuth({
      config: config(),
      credentials: { type: "from-request" },
      iterateAuth: auth,
      request: new Request(`${ORIGIN}/sign-in`),
    });
    expect(anonymous.itxAuth).toBeNull();
    expect(anonymous.principal).toBeNull();

    await expect(
      resolveOsRequestAuth({
        config: config(),
        credentials: { token: "invalid", type: "bearer" },
        iterateAuth: auth,
        request: new Request(`${ORIGIN}/api`),
      }),
    ).rejects.toThrow("missing or invalid auth");
  });
});
