import type { AuthenticatedSession } from "@iterate-com/auth/server";
import { parseAppConfigFromEnv } from "@iterate-com/shared/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "./config.ts";

const authClient = vi.hoisted(() => ({
  authenticateSession: vi.fn(),
}));

vi.mock("./auth/iterate-auth-client.ts", () => ({
  createOsIterateAuth: () => ({ authenticateSession: authClient.authenticateSession }),
}));

import { resolveItxAuth } from "./auth.ts";

const ORIGIN = "https://os.example.test";

function config() {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    env: { APP_CONFIG: JSON.stringify({ openAiApiKey: "test-openai-key" }) },
    prefix: "APP_CONFIG_",
  });
}

function session(): AuthenticatedSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    session: {
      activeOrganizationId: null,
      expiresAt: now + 300,
      organizations: [],
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
    user: { email: "one@example.test", id: "usr_one" },
  };
}

describe("resolveItxAuth", () => {
  beforeEach(() => authClient.authenticateSession.mockReset());

  it("disables session refresh inside Cap'n Web cookie authentication", async () => {
    authClient.authenticateSession.mockResolvedValue({
      responseHeaders: new Headers(),
      session: session(),
    });
    const headers = new Headers({ cookie: "iterate_session=current", origin: ORIGIN });

    const auth = await resolveItxAuth({
      config: config(),
      credentials: { type: "from-server-cookie" },
      headers,
      requestUrl: `${ORIGIN}/api`,
    });

    expect(auth.canAccessProject("prj_one")).toBe(true);
    expect(authClient.authenticateSession).toHaveBeenCalledOnce();
    expect(authClient.authenticateSession).toHaveBeenCalledWith({
      headers,
      refresh: "never",
    });
  });

  it("grants exactly one project for a verified project-secret credential", async () => {
    const verifyProjectSecret = vi.fn().mockResolvedValue(true);
    const auth = await resolveItxAuth({
      config: config(),
      credentials: { type: "project-secret", projectId: "prj_one", secret: "itxk_known" },
      headers: new Headers(),
      requestUrl: `${ORIGIN}/api`,
      verifyProjectSecret,
    });

    expect(verifyProjectSecret).toHaveBeenCalledWith({
      projectId: "prj_one",
      secret: "itxk_known",
    });
    expect(auth.isAdmin()).toBe(false);
    expect(auth.principal).toBe("project-secret:prj_one");
    expect(auth.canAccessProject("prj_one")).toBe(true);
    // No admin short-circuit, no directory to widen into: any OTHER project
    // stays out of reach, synchronously and asynchronously.
    expect(auth.canAccessProject("prj_other")).toBe(false);
    await expect(async () => auth.assertCanAccessProject("prj_other")).rejects.toThrow(/no access/);
  });

  it("rejects a project-secret credential the verifier refuses, and an empty secret without dialing", async () => {
    const verifyProjectSecret = vi.fn().mockResolvedValue(false);
    await expect(
      resolveItxAuth({
        config: config(),
        credentials: { type: "project-secret", projectId: "prj_one", secret: "wrong" },
        headers: new Headers(),
        requestUrl: `${ORIGIN}/api`,
        verifyProjectSecret,
      }),
    ).rejects.toThrow(/missing or invalid auth/);

    verifyProjectSecret.mockClear();
    await expect(
      resolveItxAuth({
        config: config(),
        credentials: { type: "project-secret", projectId: "prj_one", secret: "" },
        headers: new Headers(),
        requestUrl: `${ORIGIN}/api`,
        verifyProjectSecret,
      }),
    ).rejects.toThrow(/missing or invalid auth/);
    expect(verifyProjectSecret).not.toHaveBeenCalled();

    // A deployment (or test) that wires no verifier serves no such lane.
    await expect(
      resolveItxAuth({
        config: config(),
        credentials: { type: "project-secret", projectId: "prj_one", secret: "itxk_known" },
        headers: new Headers(),
        requestUrl: `${ORIGIN}/api`,
      }),
    ).rejects.toThrow(/missing or invalid auth/);
  });
});
