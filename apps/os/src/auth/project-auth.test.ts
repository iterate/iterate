import { describe, expect, test, vi } from "vitest";
import { ItxAuthenticationError } from "../auth.ts";
import {
  authenticateProjectRequest,
  handleProjectAuthFetch,
  handleProjectAuthStart,
  parseProjectAuthPolicy,
} from "./project-auth.ts";

const appOrigin = "https://internal--demo.iterate.app";
const osOrigin = "https://os.iterate.com";
const projectId = "prj_demo";

describe("project auth partial fetch", () => {
  test("renders login for HTML navigation and describes login for API calls", async () => {
    const html = await projectFetch(
      new Request(`${appOrigin}/events?kind=root`, { headers: { accept: "text/html" } }),
    );
    expect(html?.status).toBe(200);
    const body = (await html?.text()) ?? "";
    // The sign-in button is a link, never a form: Chromium applies
    // form-action to a submission's whole redirect chain, which silently
    // killed the logged-out hop to the iterate-auth origin.
    expect(body).toContain('href="/_iterate/auth/login?return_to=%2Fevents%3Fkind%3Droot"');
    expect(body).not.toContain("<form");
    expect(body).toContain('viewBox="0 0 500 500"');
    const csp = html?.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("style-src 'nonce-");
    expect(await projectFetch(new Request(`${appOrigin}/api/events`))).toMatchObject({
      status: 401,
    });
  });

  test("turns the local login path into a handoff to OS", async () => {
    const response = await projectFetch(
      new Request(
        `${appOrigin}/_iterate/auth/login?return_to=${encodeURIComponent("/events?kind=root")}`,
      ),
    );
    const location = new URL(response?.headers.get("location") ?? "");
    expect(location.href).toBe(
      `${osOrigin}/api/project-auth/start?return_to=${encodeURIComponent(`${appOrigin}/events?kind=root`)}`,
    );
  });

  test("redeems a fragment token into a host-only cookie", async () => {
    const callback = `${appOrigin}/_iterate/auth/callback?return_to=%2Fevents`;
    const page = await projectFetch(new Request(callback));
    expect(page?.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(await page?.text()).toContain("location.hash.slice(1)");

    const response = await projectFetch(
      new Request(callback, {
        body: "signed-token",
        headers: { "content-type": "text/plain", origin: appOrigin },
        method: "POST",
      }),
      vi.fn(async () => ({
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        userId: "usr_one",
      })),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie")).toMatch(
      /^iterate-project-auth=signed-token; Path=\/; HttpOnly; SameSite=Strict;/,
    );
    await expect(response?.json()).resolves.toEqual({ ok: true, returnTo: "/events" });
  });

  test("continues without consuming the request while the cookie remains valid", async () => {
    const validate = vi.fn(async () => ({
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      userId: "usr_one",
    }));
    const request = new Request(`${appOrigin}/private`, {
      body: "app-owned-body",
      headers: { cookie: "iterate-project-auth=signed-token" },
      method: "POST",
    });
    const allowed = await projectFetch(request, validate);
    expect(allowed).toBeNull();
    expect(request.bodyUsed).toBe(false);
    await expect(request.text()).resolves.toBe("app-owned-body");
    expect(validate).toHaveBeenCalledWith({
      audience: appOrigin,
      projectId,
      token: "signed-token",
    });

    const denied = await projectFetch(
      new Request(`${appOrigin}/private`, {
        headers: { accept: "text/html", cookie: "iterate-project-auth=revoked" },
      }),
      vi.fn(async () => null),
    );
    expect(denied?.status).toBe(200);
    expect(denied?.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("rejects cross-origin and oversized callback posts", async () => {
    const callback = `${appOrigin}/_iterate/auth/callback`;
    expect(
      (
        await projectFetch(
          new Request(callback, {
            body: "token",
            headers: { "content-type": "text/plain", origin: "https://evil.example" },
            method: "POST",
          }),
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await projectFetch(
          new Request(callback, {
            body: "x".repeat(8193),
            headers: { "content-type": "text/plain", origin: appOrigin },
            method: "POST",
          }),
        )
      )?.status,
    ).toBe(413);
  });
});

describe("project auth actor exchange", () => {
  test("rejects malformed policy as a caller authentication outcome", () => {
    expect(() => parseProjectAuthPolicy({ policy: "other" } as never)).toThrow(
      ItxAuthenticationError,
    );
  });

  test("returns the actor for an exact-origin app session without consuming a body", async () => {
    const request = new Request(`${appOrigin}/api`, {
      body: "app-owned-body",
      headers: {
        cookie: "iterate-project-auth=signed-token",
        origin: appOrigin,
      },
      method: "POST",
    });
    const validateSession = vi.fn(async () => ({
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      userId: "usr_one",
    }));

    await expect(
      authenticateProjectRequest({
        credentials: { type: "from-server-cookie" },
        projectId,
        request,
        validateSession,
      }),
    ).resolves.toMatchObject({ userId: "usr_one" });
    expect(request.bodyUsed).toBe(false);
    expect(validateSession).toHaveBeenCalledWith({
      audience: appOrigin,
      projectId,
      token: "signed-token",
    });
  });

  test("rejects missing or invalid sessions and non-exact origins", async () => {
    const validateSession = vi.fn(async () => ({ expiresAt: 1, userId: "usr_one" }));
    const invalidHeaders: HeadersInit[] = [
      { origin: appOrigin },
      { cookie: "iterate-project-auth=signed-token" },
      { cookie: "iterate-project-auth=signed-token", origin: "https://evil.example" },
    ];
    for (const headers of invalidHeaders) {
      await expect(
        authenticateProjectRequest({
          credentials: { type: "from-server-cookie" },
          projectId,
          request: new Request(`${appOrigin}/api`, { headers }),
          validateSession,
        }),
      ).rejects.toBeInstanceOf(ItxAuthenticationError);
    }

    await expect(
      authenticateProjectRequest({
        credentials: { type: "from-server-cookie" },
        projectId,
        request: new Request(`${appOrigin}/api`, {
          headers: {
            cookie: "iterate-project-auth=signed-token",
            origin: appOrigin,
          },
        }),
        validateSession: vi.fn(async () => null),
      }),
    ).rejects.toBeInstanceOf(ItxAuthenticationError);
  });

  test("rejects unknown credential shapes", async () => {
    await expect(
      authenticateProjectRequest({
        credentials: { type: "from-server-cookie", extra: true } as never,
        projectId,
        request: new Request(`${appOrigin}/api`),
        validateSession: vi.fn(async () => null),
      }),
    ).rejects.toBeInstanceOf(ItxAuthenticationError);
  });
});

describe("project auth start", () => {
  test("uses the existing OS login when there is no OS session", async () => {
    const response = await start(null);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/api/iterate-auth/login");
    expect(location.searchParams.get("return_to")).toBe(
      `/api/project-auth/start?return_to=${encodeURIComponent(`${appOrigin}/events`)}`,
    );
  });

  test("mints a project-and-origin token and returns it in the app callback fragment", async () => {
    const mintSession = vi.fn(async () => ({ token: "signed-token" }));
    const response = await start({ userId: "usr_one" }, mintSession);
    expect(mintSession).toHaveBeenCalledWith({
      audience: appOrigin,
      projectId,
      userId: "usr_one",
    });
    expect(response.headers.get("location")).toBe(
      `${appOrigin}/_iterate/auth/callback?return_to=%2Fevents#token=signed-token`,
    );
  });
});

function projectFetch(
  request: Request,
  validateSession: (input: {
    audience: string;
    projectId: string;
    token: string;
  }) => Promise<{ expiresAt: number; userId: string } | null> = vi.fn(async () => null),
): Promise<Response | null> {
  return handleProjectAuthFetch({
    osBaseUrl: osOrigin,
    projectId,
    request,
    validateSession,
  });
}

function start(
  session: { userId: string } | null,
  mintSession: (input: {
    audience: string;
    projectId: string;
    userId: string;
  }) => Promise<{ token: string } | null> = vi.fn(async () => ({ token: "signed-token" })),
) {
  const request = new Request(
    `${osOrigin}/api/project-auth/start?return_to=${encodeURIComponent(`${appOrigin}/events`)}`,
  );
  return handleProjectAuthStart({
    mintSession,
    request,
    resolveProjectId: async () => projectId,
    session,
  });
}
