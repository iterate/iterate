import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAppConfigFromEnv } from "@iterate-com/shared/config";
import {
  authenticateOperatorSession,
  handleOperatorSessionRequest,
  isSameOriginBrowserRequest,
  OPERATOR_SESSION_COOKIE,
  publicSessionForOperator,
  verifyOperatorGrant,
} from "./operator-session.ts";
import { resolveItxAuth } from "~/auth.ts";
import { AppConfig } from "~/config.ts";
import type { ProjectDirectoryRecord } from "~/project-directory.ts";

const ADMIN_SECRET = "operator-session-test-admin-secret";
const ORIGIN = "https://os.example.test";
const project: ProjectDirectoryRecord = {
  id: "prj_operator_test",
  name: "Operator Test",
  organizationId: "org_operator_test",
  slug: "operator-test",
};

afterEach(() => vi.restoreAllMocks());

function config(secret = ADMIN_SECRET) {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    env: {
      APP_CONFIG: JSON.stringify({ openAiApiKey: "test-openai-key" }),
      APP_CONFIG_ADMIN_API_SECRET: secret,
    },
    prefix: "APP_CONFIG_",
  });
}

async function issue(
  body: Record<string, unknown>,
  options: { authorization?: string; origin?: string } = {},
) {
  const request = new Request(`${ORIGIN}/api/operator-sessions`, {
    body: JSON.stringify(body),
    headers: {
      authorization: options.authorization ?? `Bearer ${ADMIN_SECRET}`,
      "content-type": "application/json",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    method: "POST",
  });
  return await handleOperatorSessionRequest({
    config: config(),
    request,
    resolveProject: async (reference) =>
      reference === project.id || reference === project.slug ? project : null,
  });
}

describe("operator sessions", () => {
  it("issues origin-bound project access without impersonating a customer or exposing the admin secret", async () => {
    const auditLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await issue({
      kind: "project",
      operatorId: "support-engineer",
      project: project.slug,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = (await response.json()) as {
      browserUrl: string;
      expiresAt: string;
      project: { id: string; slug: string };
      token: string;
    };
    expect(created.project).toEqual({ id: project.id, slug: project.slug });
    expect(created.browserUrl).toBe(
      `${ORIGIN}/api/operator-sessions/redeem#token=${encodeURIComponent(created.token)}`,
    );
    expect(JSON.stringify(created)).not.toContain(ADMIN_SECRET);
    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog.mock.calls[0]?.[0]).toContain('"operatorId":"support-engineer"');
    expect(auditLog.mock.calls[0]?.[0]).not.toContain(ADMIN_SECRET);
    expect(auditLog.mock.calls[0]?.[0]).not.toContain(created.token);

    const authenticated = await authenticateOperatorSession({
      config: config(),
      request: new Request(`${ORIGIN}/api`, {
        headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${created.token}` },
      }),
    });
    expect(authenticated?.principal).toMatchObject({
      type: "user",
      userId: "support-engineer",
      projects: [{ id: project.id, slug: project.slug }],
    });
    expect(publicSessionForOperator(authenticated)).toMatchObject({
      authenticated: true,
      session: { projects: [{ id: project.id, slug: project.slug }] },
      user: {
        email: "support-engineer@operator.invalid",
        id: "support-engineer",
        isAdmin: false,
      },
    });
  });

  it("requires the matching deployment secret and an existing project", async () => {
    expect(
      (
        await issue(
          { kind: "project", operatorId: "support-engineer", project: project.slug },
          { authorization: "Bearer wrong" },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await issue({
          kind: "project",
          operatorId: "support-engineer",
          project: "missing",
        })
      ).status,
    ).toBe(404);
  });

  it("rejects the former impersonation request shape instead of accepting it for compatibility", async () => {
    expect(
      (
        await issue({
          kind: "project",
          project: project.slug,
          subject: "customer@example.test",
        })
      ).status,
    ).toBe(400);
  });

  it("rejects cross-origin browser issuance and redemption", async () => {
    expect(
      (
        await issue(
          { kind: "admin", operatorId: "operator:alice" },
          { origin: "https://attacker.example" },
        )
      ).status,
    ).toBe(403);

    expect(
      isSameOriginBrowserRequest(
        new Request(`${ORIGIN}/api`, { headers: { origin: "https://attacker.example" } }),
      ),
    ).toBe(false);
    expect(
      isSameOriginBrowserRequest(new Request(`${ORIGIN}/api`, { headers: { origin: ORIGIN } })),
    ).toBe(true);
    expect(isSameOriginBrowserRequest(new Request(`${ORIGIN}/api`))).toBe(true);
  });

  it("redeems a valid grant into a strict HttpOnly cookie and retires the legacy cookie", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const issued = (await (
      await issue({ kind: "admin", operatorId: "operator:alice" })
    ).json()) as { token: string };
    const response = await handleOperatorSessionRequest({
      config: config(),
      request: new Request(`${ORIGIN}/api/operator-sessions/redeem`, {
        body: issued.token,
        headers: { "content-type": "text/plain", origin: ORIGIN },
        method: "POST",
      }),
      resolveProject: async () => null,
    });

    expect(response.status).toBe(200);
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain(`${OPERATOR_SESSION_COOKIE}=`);
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Strict");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("iterate-admin-auth=; Path=/");
    expect(cookies).not.toContain(ADMIN_SECRET);
  });

  it("ends an operator browser session with a same-origin cookie deletion", async () => {
    const response = await handleOperatorSessionRequest({
      config: config(),
      request: new Request(`${ORIGIN}/api/operator-sessions/current`, {
        headers: { origin: ORIGIN },
        method: "DELETE",
      }),
      resolveProject: async () => null,
    });

    expect(response.status).toBe(200);
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain(`${OPERATOR_SESSION_COOKIE}=; Path=/`);
    expect(cookies).toContain("Max-Age=0");

    const crossOrigin = await handleOperatorSessionRequest({
      config: config(),
      request: new Request(`${ORIGIN}/api/operator-sessions/current`, {
        headers: { origin: "https://attacker.example" },
        method: "DELETE",
      }),
      resolveProject: async () => null,
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("binds grants to origin, expiry, signature, and the current admin secret", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const issued = (await (
      await issue({ kind: "admin", operatorId: "operator:alice", ttlSeconds: 60 })
    ).json()) as { token: string };
    const valid = await verifyOperatorGrant({
      audience: ORIGIN,
      secret: ADMIN_SECRET,
      token: issued.token,
    });
    expect(valid?.kind).toBe("admin");
    expect(
      await verifyOperatorGrant({
        audience: "https://preview.example.test",
        secret: ADMIN_SECRET,
        token: issued.token,
      }),
    ).toBeNull();
    expect(
      await verifyOperatorGrant({ audience: ORIGIN, secret: "rotated", token: issued.token }),
    ).toBeNull();
    expect(
      await verifyOperatorGrant({
        audience: ORIGIN,
        now: valid!.expiresAt,
        secret: ADMIN_SECRET,
        token: issued.token,
      }),
    ).toBeNull();
    expect(
      await verifyOperatorGrant({
        audience: ORIGIN,
        secret: ADMIN_SECRET,
        token: `${issued.token.slice(0, -1)}x`,
      }),
    ).toBeNull();
  });

  it("denies ambient-cookie RPC auth from a cross-site browser", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const issued = (await (
      await issue({ kind: "admin", operatorId: "operator:alice" })
    ).json()) as { token: string };

    await expect(
      resolveItxAuth({
        config: config(),
        credentials: { type: "from-server-cookie" },
        headers: new Headers({
          cookie: `${OPERATOR_SESSION_COOKIE}=${issued.token}`,
          origin: "https://attacker.example",
        }),
        requestUrl: `${ORIGIN}/api`,
      }),
    ).rejects.toThrow("missing or invalid auth");
    expect(
      await authenticateOperatorSession({
        config: config(),
        request: new Request(`${ORIGIN}/projects/operator-test`, {
          headers: {
            cookie: `${OPERATOR_SESSION_COOKIE}=${issued.token}`,
            origin: "https://sibling.example.test",
          },
        }),
      }),
    ).toBeNull();
  });

  it("accepts the same signed grant as an explicit CLI/browser RPC credential", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const issued = (await (
      await issue({ kind: "project", operatorId: "support-engineer", project: project.id })
    ).json()) as { token: string };
    const auth = await resolveItxAuth({
      config: config(),
      credentials: { type: "operator-session", token: issued.token },
      headers: new Headers({ origin: "https://vitest.example" }),
      requestUrl: `${ORIGIN}/api`,
    });

    expect(auth.isAdmin()).toBe(false);
    expect(auth.canAccessProject(project.id)).toBe(true);
    expect(auth.canAccessProject("prj_other")).toBe(false);
  });
});
