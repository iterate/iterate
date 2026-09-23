import { env, SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { AccountState } from "../src/account/contract.ts";
import type { Env } from "../src/env.ts";
import { GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import { DurableObjectNameCodec } from "../src/iterate-context.ts";
import { startLoginCode } from "../src/password-and-code-sign-in.ts";
import type { OrganizationState } from "../src/organization/contract.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { controlPlaneStub, SRC_ECHO_APP, stub } from "./support.ts";

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
type Session = Awaited<ReturnType<typeof operator>>;

/** A read of the catalog — the `control-plane` facet's tables on `global:/` (src/control-plane/) —
 *  with no session between: `catalog("project", ref)`, `catalog("organization", orgId)`. */
const catalog = (method: string, ...args: unknown[]) =>
  controlPlaneStub().invoke(["itx", "facets", ["get", "control-plane"], [method, ...args]]);
/** A global context's log, whole — the root's (the control plane's record), an organization's. */
const globalLog = async (path: string) =>
  (
    (await stub(DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path })).invoke([
      "itx",
      ["readEvents", 0, 1000],
    ])) as { events: StreamEvent[] }
  ).events;
/** The person's account, folded (src/account/contract.ts) — read through their own context. */
const accountState = async (session: Session) =>
  (
    (await session.user.invoke(["itx", "facets", ["get", "account"], ["snapshot"]])) as {
      state: AccountState;
    }
  ).state;
/** The organization's record, folded (src/organization/contract.ts) — read by membership. */
const organizationState = async (session: Session, orgId: string) =>
  (
    (await (
      await session.organizations.get(orgId)
    ).invoke(["itx", "facets", ["get", "organization"], ["snapshot"]])) as {
      state: OrganizationState;
    }
  ).state;
/** `thunk` is REFUSED with `code`: an entity's refusal crosses its own log as
 *  `request-failed { code }` and is rethrown coded at the edge; the edge's own refusal is coded
 *  before anything lands. try/catch, not `.rejects`: a capnweb stub is a custom thenable. */
async function refused(
  thunk: () => Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<void> {
  let refusal: unknown;
  try {
    await thunk();
  } catch (error) {
    refusal = error;
  }
  expect(refusal, `expected a ${code} refusal, but it was allowed`).toBeDefined();
  expect((refusal as { code?: string }).code).toBe(code);
  if (message) expect((refusal as Error).message).toMatch(message);
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

test("organizations.create writes the catalog row, lands the facts on the organization and the owner's account under the asker, and records the write on the root", async () => {
  const ada = await operator("Orgs-Owner@directory.test");
  const principal = await ada.whoami();
  const org = await ada.organizations.create({ name: "  Ada's organization " });
  expect(org).toEqual({
    id: expect.stringMatching(/^org_[0-9a-f]{32}$/),
    name: "Ada's organization",
    role: "owner",
    projects: 0,
  });
  expect(await ada.organizations.list()).toEqual([org]);
  // the membership is folded on the person's account; the name and the members on the organization
  expect((await accountState(ada)).memberships).toEqual({
    [org.id]: { role: "owner", since: expect.any(String) },
  });
  const record = await organizationState(ada, org.id);
  expect(record.name).toBe("Ada's organization");
  expect(record.members).toEqual({
    [principal.actor]: { role: "owner", since: expect.any(String) },
  });
  // the facts on the organization's own log, stamped with who asked
  const facts = (await globalLog(`/organizations/${org.id}`)).filter((event) =>
    event.type.startsWith("events.iterate.com/organization/"),
  );
  expect(facts.map(({ type, payload }) => ({ type, payload }))).toEqual([
    { type: "events.iterate.com/organization/created", payload: { name: "Ada's organization" } },
    {
      type: "events.iterate.com/organization/member-added",
      payload: { orgId: org.id, userId: principal.actor, role: "owner" },
    },
  ]);
  expect(facts.every((event) => event.source?.principal?.actor === principal.actor)).toBe(true);
  // the write recorded on the root, after the fact
  const recorded = (await globalLog("/")).find(
    (event) =>
      event.type === "events.iterate.com/control-plane/organization-created" &&
      (event.payload as { orgId: string }).orgId === org.id,
  );
  expect(recorded?.payload).toEqual({
    orgId: org.id,
    name: "Ada's organization",
    ownerId: principal.actor,
  });
  expect(recorded?.source?.principal?.actor).toBe(principal.actor);
  // the catalog — the facet's tables — answers the same rows
  expect(await catalog("organization", org.id)).toEqual({
    id: org.id,
    name: "Ada's organization",
    projects: 0,
  });
  expect(await catalog("reach", principal.actor)).toEqual({
    orgs: [{ id: org.id, name: "Ada's organization", role: "owner", projects: 0 }],
    projects: [],
  });
});

test("the operator pins ids — the replay of an older directory: the user, the organization with its owner, the project answer the pinned ids, and again without error; a person pinning is refused", async () => {
  const admin = await operator();
  const pinned = {
    user: { email: "pinned@directory.test", id: "user_pinned1" },
    org: { name: "Pinned organization", id: "org_pinned1", ownerId: "user_pinned1" },
    project: { project: "pinned-slug", orgId: "org_pinned1", restoreProjectId: "prj_pinned1" },
  };
  for (const round of [1, 2]) {
    expect(await admin.users.create(pinned.user)).toEqual({
      id: "user_pinned1",
      email: "pinned@directory.test",
    });
    // the second round answers the organization as it is: its project made in the first
    expect(await admin.organizations.create(pinned.org)).toEqual({
      id: "org_pinned1",
      name: "Pinned organization",
      projects: round - 1,
    });
    using project = await admin.projects.create(pinned.project);
    expect(await project.whoami()).toMatchObject({
      projectId: "prj_pinned1",
      projectSlug: "pinned-slug",
    });
  }
  expect(await admin.users.get("user_pinned1")).toEqual(pinned.user);
  expect(await admin.users.get("pinned@directory.test")).toEqual(pinned.user);
  expect(await admin.users.list()).toEqual(expect.arrayContaining([pinned.user]));
  // the pinned person signs in as themselves and owns what was pinned for them
  const person = await operator("pinned@directory.test");
  expect(await person.whoami()).toEqual({ actor: "user_pinned1", email: "pinned@directory.test" });
  expect(await person.organizations.list()).toEqual([
    { id: "org_pinned1", name: "Pinned organization", role: "owner", projects: 1 },
  ]);
  expect(await person.projects.list()).toEqual([
    { id: "prj_pinned1", slug: "pinned-slug", orgId: "org_pinned1", role: "owner" },
  ]);
  // the pin is the operator's alone; so is naming an owner, and the user catalog
  await refused(() => person.users.create({ email: "someone@directory.test" }), "FORBIDDEN");
  await refused(
    () => person.organizations.create({ name: "Mine", id: "org_pinned2" }),
    "FORBIDDEN",
    /operator/,
  );
  await refused(
    () => person.organizations.create({ name: "Theirs", ownerId: "user_pinned1" }),
    "FORBIDDEN",
    /operator/,
  );
  await refused(
    () => person.projects.create({ project: "mine-pinned", restoreProjectId: "prj_pinned2" }),
    "FORBIDDEN",
    /admin secret/,
  );
  // an owner the catalog never heard of makes no organization
  await refused(
    () => admin.organizations.create({ name: "No orphan organization", ownerId: "user_missing" }),
    "INVALID_INPUT",
    /No user/,
  );
  expect(
    ((await catalog("organizations")) as { name: string }[]).map((org) => org.name),
  ).not.toContain("No orphan organization");
});

test("only the administrator can restore an archived project id, and neither slug nor id may be rebound", async () => {
  const email = `restore-owner-${Date.now()}@directory.test`;
  const ownerSession = await operator(email);
  const org = await ownerSession.organizations.create({ name: "restore target" });
  const archivedId = `prj_restore_${Date.now().toString(36)}`;
  await refused(
    () =>
      ownerSession.projects.create({
        project: "restored",
        orgId: org.id,
        restoreProjectId: archivedId,
      }),
    "FORBIDDEN",
    /admin secret/,
  );
  const admin = await operator();
  await refused(
    () =>
      admin.projects.create({ project: "invalid-restore", orgId: org.id, restoreProjectId: "" }),
    "INVALID_INPUT",
    /restored project id is invalid/,
  );
  using restored = await admin.projects.create({
    project: "restored",
    orgId: org.id,
    restoreProjectId: archivedId,
  });
  expect(await restored.whoami()).toMatchObject({ projectId: archivedId, projectSlug: "restored" });
  await refused(
    () =>
      admin.projects.create({ project: "restored", orgId: org.id, restoreProjectId: "prj_other" }),
    "IDENTITY_CONFLICT",
    /not the restored id/,
  );
  await refused(
    () => admin.projects.create({ project: "other", orgId: org.id, restoreProjectId: archivedId }),
    "IDENTITY_CONFLICT",
    /already belongs/,
  );
});

test("concurrent restores through the control plane: one slug never answers a different archived id, and the same archive converges", async () => {
  const admin = await operator();
  const org = await admin.organizations.create({ name: "restore race target" });
  const slug = `restore-race-${Date.now().toString(36)}`;
  const restore = (restoreProjectId: string) =>
    admin.projects
      .create({ project: slug, orgId: org.id, restoreProjectId })
      .then(async (context) => (await context.whoami()).projectId);
  // two archives racing on one slug: the first write wins, the second is refused
  const attempts = await Promise.allSettled([
    restore(`prj_${slug}_first`),
    restore(`prj_${slug}_second`),
  ]);
  const won = attempts.filter((attempt) => attempt.status === "fulfilled");
  expect(won).toHaveLength(1);
  expect(won[0]!.value).toMatch(new RegExp(`^prj_${slug}_(?:first|second)$`));
  expect(String(attempts.find((attempt) => attempt.status === "rejected")!.reason)).toMatch(
    /not the restored id|already belongs/,
  );
  // the same archive twice at once converges on it
  const replayed = `restore-replay-${Date.now().toString(36)}`;
  const replay = () =>
    admin.projects
      .create({ project: replayed, orgId: org.id, restoreProjectId: `prj_${replayed}_id` })
      .then(async (context) => (await context.whoami()).projectId);
  expect(await Promise.all([replay(), replay()])).toEqual([
    `prj_${replayed}_id`,
    `prj_${replayed}_id`,
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
