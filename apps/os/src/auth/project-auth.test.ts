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
        loginAt: Math.floor(Date.now() / 1000) - 60,
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
      loginAt: Math.floor(Date.now() / 1000) - 60,
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

    // A stale cookie on a navigation is a member who was here minutes ago:
    // hand them straight back to the login start (silent while the OS
    // session lives) instead of a sign-in page, and clear the dead cookie.
    const denied = await projectFetch(
      new Request(`${appOrigin}/private?x=1`, {
        headers: { accept: "text/html", cookie: "iterate-project-auth=revoked" },
      }),
      vi.fn(async () => null),
    );
    expect(denied?.status).toBe(302);
    expect(denied?.headers.get("location")).toBe(
      "/_iterate/auth/login?return_to=%2Fprivate%3Fx%3D1",
    );
    const cleared = denied?.headers.getSetCookie() ?? [];
    expect(
      cleared.some((c) => c.startsWith("iterate-project-auth=;") && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(cleared.some((c) => c.startsWith("iterate-project-auth-retry=1;"))).toBe(true);

    // The one-shot guard breaks a loop: bounced back with a still-dead
    // cookie, the sign-in page renders as before.
    const bounced = await projectFetch(
      new Request(`${appOrigin}/private?x=1`, {
        headers: {
          accept: "text/html",
          cookie: "iterate-project-auth=revoked; iterate-project-auth-retry=1",
        },
      }),
      vi.fn(async () => null),
    );
    expect(bounced?.status).toBe(200);
    expect(await bounced?.text()).toContain("Continue with iterate");
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

describe("project auth session refresh", () => {
  const refreshPath = `${appOrigin}/_iterate/auth/refresh?return_to=%2Fevents%3Fkind%3Droot`;
  const soon = Math.floor(Date.now() / 1000) + 300;
  const signedInAt = Math.floor(Date.now() / 1000) - 3_600;

  test("re-mints a fresh cookie for a still-valid session", async () => {
    const renewedExpiry = Math.floor(Date.now() / 1000) + 900;
    const mintSession = vi.fn(async () => ({ expiresAt: renewedExpiry, token: "fresh-token" }));
    const response = await projectFetch(
      new Request(refreshPath, {
        headers: { cookie: "iterate-project-auth=signed-token", origin: appOrigin },
        method: "POST",
      }),
      vi.fn(async () => ({
        email: "one@example.com",
        expiresAt: soon,
        image: "https://img.example/one.png",
        loginAt: signedInAt,
        name: "One",
        userId: "usr_one",
      })),
      mintSession,
    );
    expect(response?.status).toBe(200);
    // The renewed token is minted for the SAME user, project, and origin,
    // carrying the display identity the app shows and the ORIGINAL sign-in
    // (so renewals never extend a session past its absolute age) — never widened.
    expect(mintSession).toHaveBeenCalledWith({
      audience: appOrigin,
      email: "one@example.com",
      image: "https://img.example/one.png",
      loginAt: signedInAt,
      name: "One",
      projectId,
      userId: "usr_one",
    });
    const cookies = response?.headers.getSetCookie() ?? [];
    // The cookie outlives the token (30 days): a lapsed token still present
    // is what lets a later navigation re-mint silently instead of showing
    // the sign-in page.
    expect(cookies[0]).toMatch(
      /^iterate-project-auth=fresh-token; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/,
    );
    // A successful renewal also retires any loop guard from an earlier bounce.
    expect(cookies.some((c) => c.startsWith("iterate-project-auth-retry=;"))).toBe(true);
    expect(response?.headers.get("cache-control")).toContain("no-store");
    await expect(response?.json()).resolves.toEqual({ ok: true, expiresAt: renewedExpiry });
  });

  test("a session past its absolute age is not renewed, however valid its token", async () => {
    const mintSession = vi.fn(async () => ({ expiresAt: soon, token: "never" }));
    const response = await projectFetch(
      new Request(refreshPath, {
        headers: { cookie: "iterate-project-auth=old-but-valid", origin: appOrigin },
        method: "POST",
      }),
      vi.fn(async () => ({
        expiresAt: soon,
        loginAt: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
        userId: "usr_one",
      })),
      mintSession,
    );
    expect(response?.status).toBe(401);
    expect(mintSession).not.toHaveBeenCalled();
  });

  test("a renewal without an Origin is refused: it is only ever the page's own fetch", async () => {
    const mintSession = vi.fn(async () => ({ expiresAt: soon, token: "never" }));
    const response = await projectFetch(
      new Request(refreshPath, {
        headers: { cookie: "iterate-project-auth=signed-token" },
        method: "POST",
      }),
      vi.fn(async () => ({ expiresAt: soon, loginAt: signedInAt, userId: "usr_one" })),
      mintSession,
    );
    expect(response?.status).toBe(403);
    expect(mintSession).not.toHaveBeenCalled();
  });

  test("a dead session gets the login handoff, never a new token", async () => {
    const mintSession = vi.fn(async () => ({ expiresAt: soon, token: "never" }));
    const response = await projectFetch(
      new Request(refreshPath, {
        headers: { cookie: "iterate-project-auth=expired", origin: appOrigin },
        method: "POST",
      }),
      vi.fn(async () => null),
      mintSession,
    );
    expect(response?.status).toBe(401);
    expect(mintSession).not.toHaveBeenCalled();
    expect(response?.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(response?.json()).resolves.toEqual({
      authenticated: false,
      login: "/_iterate/auth/login?return_to=%2Fevents%3Fkind%3Droot",
    });
  });

  test("refuses to renew for anything but a same-origin browser POST", async () => {
    const validate = vi.fn(async () => ({
      expiresAt: soon,
      loginAt: signedInAt,
      userId: "usr_one",
    }));
    const crossOrigin = await projectFetch(
      new Request(refreshPath, {
        headers: { cookie: "iterate-project-auth=signed-token", origin: "https://evil.example" },
        method: "POST",
      }),
      validate,
    );
    expect(crossOrigin?.status).toBe(403);
    const wrongMethod = await projectFetch(
      new Request(refreshPath, { headers: { cookie: "iterate-project-auth=signed-token" } }),
      validate,
    );
    expect(wrongMethod?.status).toBe(405);
    expect(validate).not.toHaveBeenCalled();
  });

  test("a missing cookie is a plain 401 with the login pointer", async () => {
    const response = await projectFetch(
      new Request(refreshPath, { headers: { origin: appOrigin }, method: "POST" }),
    );
    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ authenticated: false });
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
      loginAt: Math.floor(Date.now() / 1000) - 60,
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
    const validateSession = vi.fn(async () => ({ expiresAt: 1, loginAt: 0, userId: "usr_one" }));
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
  validateSession: (input: { audience: string; projectId: string; token: string }) => Promise<{
    email?: string;
    expiresAt: number;
    image?: string;
    loginAt: number;
    name?: string;
    userId: string;
  } | null> = vi.fn(async () => null),
  mintSession: (input: {
    audience: string;
    email?: string;
    image?: string;
    name?: string;
    projectId: string;
    userId: string;
  }) => Promise<{ expiresAt: number; token: string } | null> = vi.fn(async () => null),
): Promise<Response | null> {
  return handleProjectAuthFetch({
    mintSession,
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
