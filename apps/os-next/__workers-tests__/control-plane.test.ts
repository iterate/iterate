import { env, SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Env } from "../src/control-plane.ts";
import { startLoginCode } from "../src/login-code.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { directory } from "../src/directory.ts";
import { applyDirectorySchema, SRC_ECHO_APP } from "./support.ts";

const origin = "https://control.test";
const secret = (env as unknown as Env).APP_CONFIG_ADMIN_API_SECRET!;
const sessions: Disposable[] = [];
beforeAll(applyDirectorySchema);
afterEach(() => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]();
  vi.restoreAllMocks();
});

async function operator(email?: string) {
  const response = await SELF.fetch(`${origin}/internal/rpc`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  const root = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(root);
  return root.authenticate({ type: "admin-secret", secret, ...(email && { as: { email } }) });
}

// Public OAuth lifecycle and browser clients are covered by oauth.test.ts.
// These tests retain the directory and ingress invariants of the former cookie API.
test("the directory keeps creation, listing, membership and event attribution coherent", async () => {
  const ada = await operator("Ada@directory.test");
  const principal = await ada.whoami();
  expect(principal).toMatchObject({
    email: "ada@directory.test",
    actor: expect.stringMatching(/^user_/),
  });
  using project = await ada.projects.create({ project: "adas-directory" });
  expect(await project.whoami()).toEqual({ projectId: "adas-directory", path: "/" });
  expect((await ada.projects.list()).map((project) => project.id)).toEqual(["adas-directory"]);
  const [event] = await project.append({
    type: "note",
    source: { principal: { actor: "forged" } },
  });
  expect(event.source?.principal).toEqual(principal);
  const bob = await operator("bob@directory.test");
  await expect(bob.projects.get("adas-directory")).rejects.toThrow(/outside/);
  await expect(bob.projects.create({ project: "adas-directory" })).rejects.toThrow(
    /taken|another/i,
  );
  expect(await (await operator("ada@directory.test")).whoami()).toEqual(principal);
  const admin = await operator();
  expect(await admin.whoami()).toEqual({ actor: "admin" });
  using _own = await admin.projects.create({ project: "admin-directory" });
  expect(await admin.projects.list()).toEqual(
    expect.arrayContaining([
      { id: "admin-directory", orgId: "org_admin" },
      expect.objectContaining({ id: "adas-directory" }),
    ]),
  );
  using other = await admin.projects.get("adas-directory");
  expect(await other.whoami()).toEqual({ projectId: "adas-directory", path: "/" });
});

test("onboarding creates owned organizations atomically and checks the selected organization", async () => {
  const db = (env as unknown as Env).DB;
  const catalog = directory(db);
  const user = await catalog.upsertUser("onboarding@directory.test");
  const reach = { userId: user.id };
  const first = await catalog.createOrg(user.id, "A first organization");
  const chosen = await catalog.createOrg(user.id, "Z selected organization");
  expect(await catalog.createProject(reach, "selected-org-project", chosen.id)).toEqual({
    id: "selected-org-project",
    orgId: chosen.id,
  });
  expect((await catalog.listOrgs(user.id)).map((org) => org.id)).toEqual([first.id, chosen.id]);
  const other = await catalog.upsertUser("other-onboarding@directory.test");
  await expect(
    catalog.createProject({ userId: other.id }, "foreign-org-project", chosen.id),
  ).rejects.toThrow(/cannot create/);
  await expect(
    catalog.createProject(
      { ...reach, projectIds: ["selected-org-project"] },
      "bound-new-project",
      chosen.id,
    ),
  ).rejects.toThrow(/creating a project needs/);
  expect(await catalog.getProject("foreign-org-project")).toBeNull();
  expect(await catalog.getProject("bound-new-project")).toBeNull();
  await expect(catalog.createOrg("missing-owner", "No orphan organization")).rejects.toThrow();
  expect(
    await db.prepare("SELECT id FROM orgs WHERE name = ?").bind("No orphan organization").first(),
  ).toBeNull();
});

test("operator RPC accepts only its administrator credential; issuer login uses the public API", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
  const login = await SELF.fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${secret}` },
    body: new URLSearchParams({ email: "fixture@directory.test", next: "https://elsewhere.test" }),
  });
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/");
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await SELF.fetch(`${origin}/api`, {
        method: "POST",
        body: "",
        headers: { cookie, Origin: origin },
      })
    ).status,
  ).toBe(200);
  const response = await SELF.fetch(`${origin}/internal/rpc`, {
    headers: { Upgrade: "websocket", cookie },
  });
  response.webSocket!.accept();
  using api = newWebSocketRpcSession<IterateRpcTarget>(response.webSocket! as unknown as WebSocket);
  await expect(api.authenticate({ type: "from-server-cookie" })).rejects.toThrow(
    /no session|sign in/,
  );
  await expect(api.authenticate({ type: "admin-secret", secret: "wrong" })).rejects.toThrow(
    /did not match/,
  );
  expect(
    (
      await SELF.fetch(`${origin}/login`, {
        method: "POST",
        headers: { Origin: "https://evil.test" },
        body: new URLSearchParams({ email: "attacker@directory.test" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (await SELF.fetch(`${origin}/.auth/logout`, { method: "GET", redirect: "manual" })).status,
  ).toBe(405);
  expect(
    (
      await SELF.fetch(`${origin}/.auth/logout`, {
        method: "POST",
        headers: { Origin: "https://evil.test" },
      })
    ).status,
  ).toBe(403);
});

test("email sign-in: the email, then the code (this config's test code), then an ordinary user session; without a mailbox or test mode there is no email sign-in", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
  const bindings = env as unknown as Env;
  // no mailbox binding and no test flag: the deployment offers no email sign-in at all
  await expect(
    startLoginCode(
      { ...bindings, EMAIL: undefined, APP_CONFIG_TEST_EMAIL_LOGIN: "false" },
      "someone@directory.test",
    ),
  ).rejects.toThrow(/Sign in with Google/);
  const post = (form: Record<string, string>, cookie?: string) =>
    SELF.fetch(`${origin}/login`, {
      method: "POST",
      redirect: "manual",
      headers: cookie ? { Origin: origin, cookie } : { Origin: origin },
      body: new URLSearchParams(form),
    });
  const started = await post({ email: "Test-Login@directory.test", next: "/sessions" });
  expect(started.status).toBe(303);
  expect(started.headers.get("location")).toBe("/login?next=%2Fsessions");
  const loginCookie = started.headers.get("set-cookie")!.split(";")[0]!;
  expect(loginCookie).toMatch(/^__Host-itx-login=/);
  // the page learns whom the code went to
  const state = await (
    await SELF.fetch(`${origin}/login.json?next=/sessions`, { headers: { cookie: loginCookie } })
  ).json<{ codeSentTo: string | null; emailSignIn: boolean }>();
  expect(state).toMatchObject({ codeSentTo: "test-login@directory.test", emailSignIn: true });
  // a wrong code goes back to the code step with the reason, and makes no session
  const wrong = await post({ code: "000000", next: "/sessions" }, loginCookie);
  expect(wrong.status).toBe(303);
  expect(new URL(wrong.headers.get("location")!, origin).searchParams.get("error")).toBe(
    "That code is not right. Try again.",
  );
  expect(wrong.headers.get("set-cookie")).toBeNull();
  // the right one (the test code, here) is the session; the login cookie ends with it
  const login = await post({ code: "424242", next: "/sessions" }, loginCookie);
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/sessions");
  const cookies = login.headers.getSetCookie();
  expect(cookies.some((cookie) => cookie.startsWith("__Host-itx-login=;"))).toBe(true);
  const session = cookies.find((cookie) => cookie.startsWith("__Host-itx-session="))!;
  const response = await SELF.fetch(`${origin}/api`, {
    headers: { Upgrade: "websocket", Origin: origin, Cookie: session.split(";")[0]! },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  using apiTransport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  const api = apiTransport.authenticate({ type: "from-server-cookie" });
  expect(await api.whoami()).toMatchObject({
    actor: expect.stringMatching(/^user_/),
    email: "test-login@directory.test",
  });
});

test("project ingress strips forged internal authority and never exposes platform credentials", async () => {
  const admin = await operator();
  using target = await admin.projects.create({ project: "directory-ingress" });
  await target.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const host = "https://echo--directory-ingress.projects.test/";
  const response = await SELF.fetch(host, {
    headers: {
      "x-itx-principal": JSON.stringify({ actor: "admin" }),
      "x-itx-expression": "itx.append",
      "x-itx-rpc-stub-pager": encodeURIComponent(
        JSON.stringify({ rpcStubKey: "forged", appendEvents: [{ type: "forged" }] }),
      ),
      cookie:
        "__Host-itx-control-plane-session=forged; __Host-itx-project-session=legacy; theme=dark",
    },
  });
  expect(await response.json()).toEqual({ principal: null, authorization: null, app: "echo" });
  expect((await target.readEvents(0, 100)).events.some((event) => event.type === "forged")).toBe(
    false,
  );
  expect(
    await (await SELF.fetch(host, { headers: { Authorization: `Bearer ${secret}` } })).json(),
  ).toEqual({
    principal: { actor: "admin" },
    authorization: null,
    app: "echo",
  });
  expect(
    (await SELF.fetch(host, { headers: { Authorization: "Bearer unrecognized" } })).status,
  ).toBe(401);
  expect((await SELF.fetch("https://unknown.projects.test/")).status).toBe(421);
});
