import { describe, expect, test, vi } from "vitest";
import { handleProjectAuthFetch, handleProjectAuthStart } from "./project-auth.ts";

const appOrigin = "https://internal--demo.iterate.app";
const osOrigin = "https://os.iterate.com";
const projectId = "prj_demo";

describe("project auth partial fetch", () => {
  test("renders login for HTML navigation and describes login for API calls", async () => {
    const html = await projectFetch(
      new Request(`${appOrigin}/events?kind=root`, { headers: { accept: "text/html" } }),
    );
    expect(html?.status).toBe(200);
    expect(await html?.text()).toContain('action="/_iterate/auth/login"');
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
      vi.fn(async () => ({ expiresAt: Math.floor(Date.now() / 1000) + 600 })),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie")).toMatch(
      /^iterate-project-auth=signed-token; Path=\/; HttpOnly; SameSite=Strict;/,
    );
    await expect(response?.json()).resolves.toEqual({ ok: true, returnTo: "/events" });
  });

  test("continues only while the cookie validates for this project and origin", async () => {
    const validate = vi.fn(async () => ({ expiresAt: Math.floor(Date.now() / 1000) + 600 }));
    const allowed = await projectFetch(
      new Request(`${appOrigin}/private`, {
        headers: { cookie: "iterate-project-auth=signed-token" },
      }),
      validate,
    );
    expect(allowed).toBeNull();
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
  }) => Promise<{ expiresAt: number } | null> = vi.fn(async () => null),
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
