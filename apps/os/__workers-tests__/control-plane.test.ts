import { env, SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { startLoginCode } from "../src/password-and-code-sign-in.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { directory } from "../src/directory.ts";
import { applyDirectorySchema, SRC_ECHO_APP } from "./support.ts";

const origin = "https://control.test";
const secret = (env as unknown as Env).APP_CONFIG_SECRETS__ADMIN_BEARER!;
const password = (env as unknown as Env).APP_CONFIG_LOGIN__PASSWORD!;
const sessions: Disposable[] = [];
/** The sign-in page's own post — same-origin, a form — with or without a browser's cookie. */
const postLogin = (form: Record<string, string>, cookie?: string) =>
  SELF.fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: cookie ? { Origin: origin, cookie } : { Origin: origin },
    body: new URLSearchParams(form),
  });
beforeAll(applyDirectorySchema);
afterEach(() => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]();
  vi.restoreAllMocks();
});

/** A bare `/api` socket, authenticated in-band with the admin secret — every project, or `as` a user. */
async function operator(email?: string) {
  const response = await SELF.fetch(`${origin}/api`, {
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
  // the project's id is minted; its name is the slug — the list carries both
  const adasRoot = await project.whoami();
  expect(adasRoot).toEqual({
    projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    path: "/",
    projectSlug: "adas-directory",
    projectUrl: "https://adas-directory.projects.test/",
  });
  const adasProjectId = adasRoot.projectId;
  expect((await ada.projects.list()).map(({ id, slug }) => ({ id, slug }))).toEqual([
    { id: adasProjectId, slug: "adas-directory" },
  ]);
  // the slug names the project too (a URL's /projects/<slug>): the directory resolves it to the id
  using bySlug = await ada.projects.get("adas-directory");
  expect(await bySlug.whoami()).toEqual({
    projectId: adasProjectId,
    path: "/",
    projectSlug: "adas-directory",
    projectUrl: "https://adas-directory.projects.test/",
  });
  const [event] = await project.append({
    type: "note",
    source: { principal: { actor: "forged" } },
  });
  expect(event.source?.principal).toEqual(principal);
  const bob = await operator("bob@directory.test");
  await expect(bob.projects.get(adasProjectId)).rejects.toThrow(/outside/);
  await expect(bob.projects.create({ project: "adas-directory" })).rejects.toThrow(
    /taken|another/i,
  );
  expect(await (await operator("ada@directory.test")).whoami()).toEqual(principal);
  const admin = await operator();
  expect(await admin.whoami()).toEqual({ actor: "admin" });
  using _own = await admin.projects.create({ project: "admin-directory" });
  expect(await admin.projects.list()).toEqual(
    expect.arrayContaining([
      {
        id: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
        slug: "admin-directory",
        orgId: "org_admin",
      },
      expect.objectContaining({ id: adasProjectId, slug: "adas-directory" }),
    ]),
  );
  using other = await admin.projects.get(adasProjectId);
  expect(await other.whoami()).toEqual({
    projectId: adasProjectId,
    path: "/",
    projectSlug: "adas-directory",
    projectUrl: "https://adas-directory.projects.test/",
  });
});

test("onboarding creates owned organizations atomically and checks the selected organization", async () => {
  const db = (env as unknown as Env).DB;
  const catalog = directory(db);
  const user = await catalog.upsertUser("onboarding@directory.test");
  const reach = { userId: user.id };
  const first = await catalog.createOrg(user.id, "A first organization");
  const chosen = await catalog.createOrg(user.id, "Z selected organization");
  const selected = await catalog.createProject(reach, "selected-org-project", chosen.id);
  expect(selected).toEqual({
    id: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    slug: "selected-org-project",
    orgId: chosen.id,
  });
  // the same name in its own organization is the same project; the id reads it, so does the slug
  expect(await catalog.createProject(reach, "selected-org-project", chosen.id)).toEqual(selected);
  expect(await catalog.getProject(selected.id)).toEqual(selected);
  expect(await catalog.getProject("selected-org-project")).toEqual(selected);
  expect((await catalog.listOrgs(user.id)).map((org) => org.id)).toEqual([first.id, chosen.id]);
  const other = await catalog.upsertUser("other-onboarding@directory.test");
  await expect(
    catalog.createProject({ userId: other.id }, "foreign-org-project", chosen.id),
  ).rejects.toThrow(/cannot create/);
  await expect(
    catalog.createProject({ ...reach, projectIds: [selected.id] }, "bound-new-project", chosen.id),
  ).rejects.toThrow(/creating a project needs/);
  expect(await catalog.getProject("foreign-org-project")).toBeNull();
  expect(await catalog.getProject("bound-new-project")).toBeNull();
  await expect(catalog.createOrg("missing-owner", "No orphan organization")).rejects.toThrow();
  expect(
    await db.prepare("SELECT id FROM orgs WHERE name = ?").bind("No orphan organization").first(),
  ).toBeNull();
  // rename and delete are the owner's: a member who owns nothing is refused, and an organization
  // that still holds a project stays
  expect(await catalog.renameOrg(user.id, first.id, "  A renamed organization ")).toEqual({
    ...first,
    name: "A renamed organization",
  });
  expect((await catalog.listOrgs(user.id)).map((org) => org.name)).toEqual([
    "A renamed organization",
    "Z selected organization",
  ]);
  await expect(catalog.renameOrg(other.id, first.id, "Not mine")).rejects.toThrow(/owner/);
  await expect(catalog.deleteOrg(user.id, chosen.id)).rejects.toThrow(/still holds 1 project/);
  await catalog.deleteOrg(user.id, first.id);
  expect((await catalog.listOrgs(user.id)).map((org) => org.id)).toEqual([chosen.id]);
});

test("only the administrator can restore an archived project id, and neither slug nor id may be rebound", async () => {
  const catalog = directory((env as unknown as Env).DB);
  const email = `restore-owner-${Date.now()}@directory.test`;
  const owner = await catalog.upsertUser(email);
  const org = await catalog.createOrg(owner.id, "restore target");
  const archivedId = `prj_restore_${Date.now().toString(36)}`;
  const ownerSession = await operator(email);

  await expect(
    ownerSession.projects.create({
      project: "restored",
      orgId: org.id,
      restoreProjectId: archivedId,
    }),
  ).rejects.toThrow(/admin secret/);

  const admin = await operator();
  await expect(
    admin.projects.create({ project: "invalid-restore", orgId: org.id, restoreProjectId: "" }),
  ).rejects.toThrow(/restored project id is invalid/);
  using restored = await admin.projects.create({
    project: "restored",
    orgId: org.id,
    restoreProjectId: archivedId,
  });
  expect(await restored.whoami()).toMatchObject({ projectId: archivedId, projectSlug: "restored" });
  await expect(
    admin.projects.create({ project: "restored", orgId: org.id, restoreProjectId: "prj_other" }),
  ).rejects.toThrow(/not restored id/);
  await expect(
    admin.projects.create({ project: "other", orgId: org.id, restoreProjectId: archivedId }),
  ).rejects.toThrow(/already belongs/);
});

test("concurrent restores of one slug never return a different archived id", async () => {
  const catalog = directory((env as unknown as Env).DB);
  const owner = await catalog.upsertUser(`restore-race-${Date.now()}@directory.test`);
  const org = await catalog.createOrg(owner.id, "restore race target");
  const slug = `restore-race-${Date.now().toString(36)}`;
  const firstId = `prj_${slug}_first`;
  const secondId = `prj_${slug}_second`;
  const attempts = await Promise.allSettled([
    catalog.createProject("every", slug, org.id, firstId),
    catalog.createProject("every", slug, org.id, secondId),
  ]);

  const restored = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  expect(restored).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(restored[0]!.value.id).toMatch(new RegExp(`^prj_${slug}_(?:first|second)$`));
  expect(String(rejected[0]!.reason)).toMatch(/not restored id|already belongs/);
});

test("concurrent replays of the same archived identity converge", async () => {
  const catalog = directory((env as unknown as Env).DB);
  const owner = await catalog.upsertUser(`restore-replay-${Date.now()}@directory.test`);
  const org = await catalog.createOrg(owner.id, "restore replay target");
  const slug = `restore-replay-${Date.now().toString(36)}`;
  const archivedId = `prj_${slug}_id`;
  const restored = await Promise.all([
    catalog.createProject("every", slug, org.id, archivedId),
    catalog.createProject("every", slug, org.id, archivedId),
  ]);

  expect(restored).toEqual([
    { id: archivedId, slug, orgId: org.id },
    { id: archivedId, slug, orgId: org.id },
  ]);
});

test("a bare /api socket carries no session until a credential is verified in-band; issuer login is the page's password post, never the bearer", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
  // the bearer signs nobody in: the operator door is `/api` and `/mcp`, not the sign-in page
  const bearerLogin = await SELF.fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${secret}`, Origin: origin },
    body: new URLSearchParams({ email: "fixture@directory.test", next: "/" }),
  });
  expect(bearerLogin.status).not.toBe(302);
  expect(bearerLogin.headers.get("set-cookie") ?? "").not.toMatch(/__Host-itx-session=/);
  const login = await postLogin({
    email: "fixture@directory.test",
    password,
    next: "https://elsewhere.test", // another origin is not a place to continue to: the page's own
  });
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/");
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  expect(
    (
      await SELF.fetch(`${origin}/api`, {
        method: "POST",
        body: "",
        headers: { cookie, Origin: origin },
      })
    ).status,
  ).toBe(200);
  // a bare socket — no cookie, no bearer on the upgrade — holds nothing until a credential is verified
  const response = await SELF.fetch(`${origin}/api`, { headers: { Upgrade: "websocket" } });
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

test("password sign-in: the email and the password make an ordinary user session; a wrong password is refused in place; without a mailbox there is no email sign-in", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
  const bindings = env as unknown as Env;
  // no mailbox binding: the deployment offers no email sign-in at all (the password stays)
  await expect(
    startLoginCode({ ...bindings, EMAIL: undefined }, "someone@directory.test"),
  ).rejects.toThrow();
  // the page learns which sign-ins this deployment offers — this lane's config has all three
  const state = await (
    await SELF.fetch(`${origin}/login.json?next=/sessions`)
  ).json<{
    password: boolean;
    emailSignIn: boolean;
    google: string | null;
    cloudflare: string | null;
  }>();
  expect(state).toMatchObject({ password: true, emailSignIn: true });
  expect(state.google).toMatch(/^\/\.auth\/identity/);
  expect(state.cloudflare).toBe("/.auth/identity/cloudflare?next=%2Fsessions");
  // a wrong password goes back to the page with the reason, and makes no session
  const wrong = await postLogin({
    email: "Test-Login@directory.test",
    password: "not-the-password",
    next: "/sessions",
  });
  expect(wrong.status).toBe(303);
  const bounced = new URL(wrong.headers.get("location")!, origin);
  expect(bounced.pathname).toBe("/login");
  expect(bounced.searchParams.get("next")).toBe("/sessions");
  expect(bounced.searchParams.get("error")).toBeTruthy();
  expect(bounced.searchParams.get("method")).toBe("password");
  const retryState = await SELF.fetch(`${origin}/login.json${bounced.search}`).then((r) =>
    r.json(),
  );
  expect(retryState).toMatchObject({ passwordSelected: true, email: "Test-Login@directory.test" });
  expect(wrong.headers.get("set-cookie") ?? "").not.toMatch(/__Host-itx-session=/);
  // the right one is the session — the email lowercased, the user created on first sign-in
  const login = await postLogin({
    email: "Test-Login@directory.test",
    password,
    next: "/sessions",
  });
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/sessions");
  const session = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Host-itx-session="))!;
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

test("password sign-in rests an address after five wrong tries: the sixth is refused as too many, right or wrong", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
  const email = "limited@directory.test";
  const errors: string[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const refused = await postLogin({ email, password: "wrong", next: "/" });
    expect(refused.status).toBe(303);
    errors.push(new URL(refused.headers.get("location")!, origin).searchParams.get("error") ?? "");
  }
  expect(errors.slice(0, 5).every((error) => error && !/too many/i.test(error))).toBe(true);
  expect(errors[5]).toMatch(/too many/i);
  const late = await postLogin({ email, password, next: "/" });
  expect(late.status).toBe(303);
  expect(new URL(late.headers.get("location")!, origin).searchParams.get("error")).toMatch(
    /too many/i,
  );
  // another address is untouched by that one's tries
  expect((await postLogin({ email: "unlimited@directory.test", password, next: "/" })).status).toBe(
    302,
  );
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
