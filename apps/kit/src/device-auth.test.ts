// The Kit HTTP boundary with stored session doubles. Real issuer consent is verified on a deployed preview.
import { expect, test, vi } from "vitest";
import type { BrowserHost, BrowserSession } from "iterate/app-session";
import { deviceAuth } from "./device-auth.ts";

const origin = "https://kit-preview.example";
const cookie = "__Host-itx-session=11111111-1111-4111-8111-111111111111";
const selfHost = "https://iterate.someone.workers.dev";

test("choosing a device starts its branded client before consent, with a new identity even for two of the same model", async () => {
  const f = fixture();
  const ids = [];
  for (const model of ["satellite1", "home-assistant-voice-preview-edition", "satellite1"]) {
    const response = await deviceAuth(
      new Request(`${origin}/devices/${model}/login`, {
        method: "POST",
        headers: { origin, cookie },
      }),
      f.env,
      f.deps,
    );
    expect(response?.status).toBe(303);
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    const [host, next] = f.begin.mock.lastCall!;
    expect(host.client?.id).toMatch(
      new RegExp(`^${origin}/devices/${model}/clients/[^/]+\\.json$`),
    );
    expect(host.client?.logoUri).toBe(
      `${origin}/vendors/${model === "satellite1" ? "futureproofhomes" : "home-assistant"}.png`,
    );
    expect(host.client?.name).toBe(
      model === "satellite1"
        ? "FutureProofHomes Satellite1"
        : "Home Assistant Voice Preview Edition",
    );
    expect(next).toBe(`/devices/${model}/firmware/latest`);
    ids.push(host.client?.id);
  }
  expect(new Set(ids)).toMatchObject({ size: 3 });
  expect(f.end).toHaveBeenCalledTimes(3);
  expect(f.end.mock.invocationCallOrder[0]).toBeLessThan(f.begin.mock.invocationCallOrder[0]!);
});

test("GETs and cross-origin requests cannot replace a device session", async () => {
  const f = fixture();
  for (const [method, headers, status] of [
    ["GET", { origin, cookie }, 405],
    ["POST", { origin: "https://other.example", cookie }, 403],
    ["POST", { cookie }, 403],
  ] as const) {
    expect(
      (
        await deviceAuth(
          new Request(`${origin}/devices/satellite1/login`, { method, headers }),
          f.env,
          f.deps,
        )
      )?.status,
    ).toBe(status);
  }
  expect(f.end).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
});

test("setup reads the stored consent identity; query parameters cannot change it", async () => {
  const f = fixture();
  const response = await deviceAuth(
    new Request(`${origin}/device-session.json?device=waveshare&clientId=attacker`, {
      headers: { cookie },
    }),
    f.env,
    f.deps,
  );
  expect(await response?.json()).toEqual({
    deviceId: "satellite1",
    clientId: (await f.client()).id,
  });
  f.bearer.mockResolvedValue(null);
  expect(
    (
      await deviceAuth(
        new Request(`${origin}/device-session.json`, { headers: { cookie } }),
        f.env,
        f.deps,
      )
    )?.status,
  ).toBe(401);
});

test("generic login and old firmware bookmarks return to device selection without starting generic consent", async () => {
  const f = fixture();
  const response = await deviceAuth(
    new Request(`${origin}/.auth/login?next=/devices/satellite1/firmware/latest`),
    f.env,
    f.deps,
  );
  expect(response?.headers.get("location")).toBe("/?device=satellite1");
  expect(await deviceAuth(new Request(`${origin}/`), f.env, f.deps)).toBeNull();
  expect(f.begin).not.toHaveBeenCalled();
});

test("a failed sign-out is logged and doesn't block setting up the next board", async () => {
  const f = fixture();
  f.end.mockRejectedValue(new Error("Sign-out could not reach Iterate (500). Try again."));
  f.host.mockResolvedValue({
    issuer: "https://gone.example",
    resource: "https://gone.example/api",
  });
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await deviceAuth(
      new Request(`${origin}/devices/satellite1/login?issuer=${encodeURIComponent(selfHost)}`, {
        method: "POST",
        headers: { origin, cookie },
      }),
      f.env,
      f.deps,
    );
    expect(response?.status).toBe(303);
    expect(f.begin).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("kit.device_login_left_session", {
      platform: "https://gone.example",
      error: "Sign-out could not reach Iterate (500). Try again.",
    });
  } finally {
    log.mockRestore();
  }
});
test("a connect link to another iterate platform carries it to device selection, checked", async () => {
  const f = fixture();
  const connect = await deviceAuth(
    new Request(
      `${origin}/.auth/connect?issuer=${encodeURIComponent(`${selfHost}/some/path`)}&next=/devices/satellite1/firmware/latest`,
    ),
    f.env,
    f.deps,
  );
  expect(connect?.status).toBe(303);
  expect(connect?.headers.get("location")).toBe(
    `/?device=satellite1&issuer=${encodeURIComponent(selfHost)}`,
  );

  const denied = await deviceAuth(
    new Request(`${origin}/.auth/connect?issuer=https://look-alike.iterate.app`),
    f.env,
    f.deps,
  );
  expect(denied?.status).toBe(400);
  expect(await denied?.text()).toContain("not an issuer this app can be connected to");
  expect(f.begin).not.toHaveBeenCalled();
});

test("choosing a device for another iterate platform starts its consent on that platform", async () => {
  const f = fixture();
  const response = await deviceAuth(
    new Request(
      `${origin}/devices/home-assistant-voice-preview-edition/login?issuer=${encodeURIComponent(selfHost)}`,
      { method: "POST", headers: { origin, cookie } },
    ),
    f.env,
    f.deps,
  );
  expect(response?.status).toBe(303);
  expect(f.deps.issuerAnswersAt).toHaveBeenCalledWith(selfHost);
  const [host] = f.begin.mock.lastCall!;
  expect(host).toMatchObject({
    issuer: selfHost,
    resource: `${selfHost}/api`,
    client: { name: "Home Assistant Voice Preview Edition" },
  });
});

test("a platform that doesn't answer as iterate is refused before any session changes", async () => {
  const f = fixture();
  f.deps.issuerAnswersAt.mockResolvedValue(
    "iterate.someone.workers.dev does not answer as an iterate platform.",
  );
  const response = await deviceAuth(
    new Request(`${origin}/devices/satellite1/login?issuer=${encodeURIComponent(selfHost)}`, {
      method: "POST",
      headers: { origin, cookie },
    }),
    f.env,
    f.deps,
  );
  expect(response?.status).toBe(400);
  expect(await response?.text()).toContain("does not answer as an iterate platform");
  expect(f.end).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
});

function fixture() {
  const begin = vi.fn(
    async (_host: BrowserHost, _next: string) => "https://issuer.example/oauth2/auth",
  );
  const end = vi.fn(async () => {});
  const client = vi.fn(async () => ({
    id: `${origin}/devices/satellite1/clients/22222222-2222-4222-8222-222222222222.json`,
    name: "Satellite1",
    logoUri: `${origin}/vendors/futureproofhomes.png`,
  }));
  const bearer = vi.fn(async (): Promise<string | null> => "token");
  const host = vi.fn(
    async (): Promise<{ issuer: string; resource: string } | null> => ({
      issuer: "https://issuer.example",
      resource: "https://issuer.example/api",
    }),
  );
  const sessions = {
    getByName: () => ({ begin, end, client, bearer, host }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const issuerAnswersAt = vi.fn(async (_origin: string): Promise<string | null> => null);
  return {
    env: {
      BROWSER_SESSION: sessions,
      ITERATE_ORIGIN: "https://issuer.example",
      ITERATE_DENY_ZONES: "iterate.app,iterate.com",
    },
    deps: { issuerAnswersAt },
    begin,
    end,
    client,
    bearer,
    host,
  };
}
