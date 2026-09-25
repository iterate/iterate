import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import type { AccountState } from "../src/account/contract.ts";
import type { ControlPlaneDurableObject } from "../src/control-plane/durable-object.ts";
import { ControlPlane } from "../src/control-plane/edge.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import { startLoginCode } from "../src/password-and-code-sign-in.ts";
import type { OrganizationState } from "../src/organization/contract.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import {
  adminSession,
  controlPlaneStub,
  ORIGIN,
  publishConfigWorker,
  refused,
  SRC_ECHO_APP,
  stub,
  until,
} from "./support.ts";

const secret = env.APP_CONFIG_SECRETS__ADMIN_BEARER!;
const password = env.APP_CONFIG_LOGIN__PASSWORD!;
type Session = Awaited<ReturnType<typeof operator>>;

// Public OAuth lifecycle and browser clients are covered by oauth.test.ts.
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

test("organizations.create writes the catalog row and lands the facts on the organization and the owner's account under the asker", async () => {
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
  expect(await accountState(ada)).toMatchObject({
    memberships: { [org.id]: { role: "owner", since: expect.any(String) } },
  });
  expect(await organizationState(ada, org.id)).toMatchObject({
    name: "Ada's organization",
    members: { [principal.actor]: { role: "owner", since: expect.any(String) } },
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
  // the control-plane database — the source of truth behind the folds — answers the same rows
  expect(await catalog("organization", org.id)).toEqual({
    id: org.id,
    name: "Ada's organization",
    projects: 0,
  });
  expect(await catalog("accessibleTo", principal.actor)).toEqual({
    organizations: [{ id: org.id, name: "Ada's organization", role: "owner", projects: 0 }],
    projects: [],
  });
});

test("the operator names an organization's owner and restores a project's id; a person doing either is refused", async () => {
  const admin = await operator();
  const user = await admin.users.create({ email: "owned@directory.test" });
  // find-or-create: the same email answers the same person
  expect(await admin.users.create({ email: "owned@directory.test" })).toEqual(user);
  const org = await admin.organizations.create({ name: "Named organization", ownerId: user.id });
  expect(org).toEqual({
    id: expect.stringMatching(/^org_/),
    name: "Named organization",
    projects: 0,
  });
  using project = await admin.projects.create({
    project: "restored-slug",
    orgId: org.id,
    restoreProjectId: "prj_restored1",
  });
  expect(await project.whoami()).toMatchObject({
    projectId: "prj_restored1",
    projectSlug: "restored-slug",
  });
  expect(await admin.users.get(user.id)).toEqual(user);
  expect(await admin.users.get("owned@directory.test")).toEqual(user);
  expect(await admin.users.list()).toEqual(expect.arrayContaining([user]));
  // the named owner signs in as themselves and owns what was made for them
  const person = await operator("owned@directory.test");
  expect(await person.whoami()).toEqual({ actor: user.id, email: "owned@directory.test" });
  expect(await person.organizations.list()).toEqual([
    { id: org.id, name: "Named organization", role: "owner", projects: 1 },
  ]);
  expect(await person.projects.list()).toEqual([
    { id: "prj_restored1", slug: "restored-slug", orgId: org.id, role: "owner" },
  ]);
  // naming an owner is the operator's alone; so is the user catalog
  await refused(() => person.users.create({ email: "someone@directory.test" }), "FORBIDDEN");
  await refused(
    () => person.organizations.create({ name: "Theirs", ownerId: user.id }),
    "FORBIDDEN",
    /operator/,
  );
  await refused(
    () => person.projects.create({ project: "mine-restored", restoreProjectId: "prj_restored2" }),
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
    ((await catalog("organizations")) as { name: string }[]).map((candidate) => candidate.name),
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

test("the operator's project in a named organization lands on the organization's record — the list the dash shows — as a person's does; the same creation again (a project seed's apply, rerun, or two at once) lands nothing twice, and lands one the record lacks", async () => {
  const admin = await operator();
  // what a seed's apply does: the owner (the operator acting as them) makes the organization, the
  // operator itself makes the project under its archived id
  const owner = await operator("seed-owner@directory.test");
  const { actor: ownerActor } = await owner.whoami();
  const org = await owner.organizations.create({ name: "Seeded organization" });
  const projectFacts = async () =>
    (await globalLog(`/organizations/${org.id}`))
      .filter((event) => event.type === "events.iterate.com/organization/project-added")
      .map(({ payload, source }) => ({ payload, platform: source?.platform }));
  const restore = (project: string, restoreProjectId: string) =>
    admin.projects.create({ project, orgId: org.id, restoreProjectId });
  using _seeded = await restore("seeded", "prj_seeded");
  expect(await organizationState(owner, org.id)).toMatchObject({
    projects: { prj_seeded: { slug: "seeded", createdAt: expect.any(String) } },
  });
  // the operator lands the project, never itself: the organization's members are still the owner
  expect(Object.keys((await organizationState(owner, org.id)).members)).toEqual([ownerActor]);
  // the same creation again answers the same project and lands no second fact
  using again = await restore("seeded", "prj_seeded");
  expect(await again.whoami()).toMatchObject({ projectId: "prj_seeded" });
  expect(await projectFacts()).toEqual([
    { payload: { projectId: "prj_seeded", slug: "seeded" }, platform: true },
  ]);
  // a project the catalog holds and the record lacks (the operator's creations landed nothing
  // before): the next create lands it — once, however often it is asked
  await controlPlaneStub().createProject(
    { principal: { actor: "admin" } },
    { project: "seeded-earlier", organizationId: org.id, restoreProjectId: "prj_seeded_earlier" },
  );
  expect((await organizationState(owner, org.id)).projects).not.toHaveProperty(
    "prj_seeded_earlier",
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    using _converged = await restore("seeded-earlier", "prj_seeded_earlier");
  }
  expect(await projectFacts()).toEqual([
    { payload: { projectId: "prj_seeded", slug: "seeded" }, platform: true },
    { payload: { projectId: "prj_seeded_earlier", slug: "seeded-earlier" }, platform: true },
  ]);
  // two creations at the same moment both read the record without it: the key lands it once
  const raced = await Promise.all([restore("raced", "prj_raced"), restore("raced", "prj_raced")]);
  for (const context of raced) context[Symbol.dispose]();
  expect(await projectFacts()).toEqual([
    { payload: { projectId: "prj_seeded", slug: "seeded" }, platform: true },
    { payload: { projectId: "prj_seeded_earlier", slug: "seeded-earlier" }, platform: true },
    { payload: { projectId: "prj_raced", slug: "raced" }, platform: true },
  ]);
  expect(Object.keys((await organizationState(owner, org.id)).projects).sort()).toEqual([
    "prj_raced",
    "prj_seeded",
    "prj_seeded_earlier",
  ]);
  // a member can't take a project's key first (src/context/built-ins.ts `append`): the same event
  // unkeyed stays on the log, attributed to them, and the fold ignores it; the platform's lands once
  using ownersRecord = await owner.organizations.get(org.id);
  const squat = {
    type: "events.iterate.com/organization/project-added",
    payload: { projectId: "prj_squatted", slug: "someone-elses" },
  };
  await refused(
    () =>
      ownersRecord.append({
        ...squat,
        idempotencyKey: "organization/project-added:prj_squatted",
      }),
    "FORBIDDEN",
    /the platform's/,
  );
  await ownersRecord.append(squat);
  using _squatted = await restore("squatted", "prj_squatted");
  expect((await organizationState(owner, org.id)).projects).toMatchObject({
    prj_squatted: { slug: "squatted" },
  });
  expect((await projectFacts()).slice(3)).toEqual([
    { payload: { projectId: "prj_squatted", slug: "someone-elses" }, platform: undefined },
    { payload: { projectId: "prj_squatted", slug: "squatted" }, platform: true },
  ]);
  // the deployment's own organization (the operator's projects with no orgId) has no record to land on
  using _own = await admin.projects.create({ project: "operator-own" });
  expect(
    (await globalLog("/organizations/org_admin")).filter((event) =>
      event.type.startsWith("events.iterate.com/organization/"),
    ),
  ).toEqual([]);
});

test("a person's first project mints their organization: its record gets the creation, the owner and the project in that order; the owner's account the membership, in the background", async () => {
  const person = await operator("first-project@directory.test");
  const { actor } = await person.whoami();
  using _project = await person.projects.create({ project: "first-of-mine" });
  const [org] = await person.organizations.list();
  expect(org).toMatchObject({ name: "first-project", role: "owner", projects: 1 });
  const facts = (await globalLog(`/organizations/${org!.id}`)).filter((event) =>
    event.type.startsWith("events.iterate.com/organization/"),
  );
  const { id: projectId } = (await person.projects.list())[0]!;
  expect(facts.map(({ type, payload }) => ({ type, payload }))).toEqual([
    { type: "events.iterate.com/organization/created", payload: { name: "first-project" } },
    {
      type: "events.iterate.com/organization/member-added",
      payload: { orgId: org!.id, userId: actor, role: "owner", mint: true },
    },
    {
      type: "events.iterate.com/organization/project-added",
      payload: { projectId, slug: "first-of-mine" },
    },
  ]);
  expect(await organizationState(person, org!.id)).toMatchObject({
    name: "first-project",
    members: { [actor]: { role: "owner" } },
    projects: { [projectId]: { slug: "first-of-mine" } },
  });
  // the account's membership lands in the background: the creation never waits on it
  // (project-create-holds-no-account.test.ts)
  expect(
    await until(
      "the membership lands on the owner's account",
      async () => (await accountState(person)).memberships[org!.id],
    ),
  ).toMatchObject({ role: "owner" });
  // the next one lands in the same organization, and only the project lands
  using _second = await person.projects.create({ project: "second-of-mine" });
  expect(
    (await globalLog(`/organizations/${org!.id}`))
      .filter((event) => event.type.startsWith("events.iterate.com/organization/"))
      .map(({ type }) => type)
      .slice(3),
  ).toEqual(["events.iterate.com/organization/project-added"]);
  // a person's first two projects at once mint one organization, created and joined once
  const racer = await operator("first-two@directory.test");
  const racing = await Promise.all([
    racer.projects.create({ project: "first-two-a" }),
    racer.projects.create({ project: "first-two-b" }),
  ]);
  for (const context of racing) context[Symbol.dispose]();
  const racerOrgs = await racer.organizations.list();
  expect(racerOrgs).toMatchObject([{ name: "first-two", projects: 2 }]);
  expect(
    (await globalLog(`/organizations/${racerOrgs[0]!.id}`))
      .filter((event) => event.type.startsWith("events.iterate.com/organization/"))
      .map(({ type }) => type.replace("events.iterate.com/organization/", "")),
  ).toEqual(["created", "member-added", "project-added", "project-added"]);
});

test("a bare /api socket carries no session until a credential is verified in-band; issuer login is the page's password post, never the bearer", async () => {
  fetchReachesThisWorker();
  // the bearer signs nobody in: the operator's endpoints are `/api` and `/mcp`, not the sign-in page
  const bearerLogin = await exports.default.fetch(`${ORIGIN}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${secret}`, Origin: ORIGIN },
    body: new URLSearchParams({ email: "fixture@directory.test", next: "/" }),
  });
  expect(bearerLogin).not.toMatchObject({ status: 302 });
  expect(bearerLogin.headers.get("set-cookie") ?? "").not.toMatch(/__Host-itx-session=/);
  const login = await postLogin({
    email: "fixture@directory.test",
    password,
    next: "https://elsewhere.test", // another ORIGIN is not a place to continue to: the page's own
  });
  expect(login).toMatchObject({ status: 302 });
  expect(login.headers.get("location")).toBe("/");
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  expect(
    await exports.default.fetch(`${ORIGIN}/api`, {
      method: "POST",
      body: "",
      headers: { cookie, Origin: ORIGIN },
    }),
  ).toMatchObject({ status: 200 });
  // a bare socket — no cookie, no bearer on the upgrade — holds nothing until a credential is verified
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
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
    await exports.default.fetch(`${ORIGIN}/login`, {
      method: "POST",
      headers: { Origin: "https://evil.test" },
      body: new URLSearchParams({ email: "attacker@directory.test" }),
    }),
  ).toMatchObject({ status: 403 });
  expect(
    await exports.default.fetch(`${ORIGIN}/.auth/logout`, { method: "GET", redirect: "manual" }),
  ).toMatchObject({ status: 405 });
  expect(
    await exports.default.fetch(`${ORIGIN}/.auth/logout`, {
      method: "POST",
      headers: { Origin: "https://evil.test" },
    }),
  ).toMatchObject({ status: 403 });
});

test("password sign-in: the email and the password make an ordinary user session; a wrong password is refused in place; without a mailbox there is no email sign-in", async () => {
  fetchReachesThisWorker();
  // no mailbox binding: the deployment offers no email sign-in at all (the password stays)
  await expect(
    startLoginCode({ ...env, EMAIL: undefined }, "someone@directory.test", null),
  ).rejects.toThrow();
  // The page renders the offered sign-ins in its initial HTML.
  const page = await exports.default.fetch(`${ORIGIN}/login?next=/sessions`);
  expect(page).toMatchObject({ status: 200 });
  const html = await page.text();
  expect(html).toContain("Use password instead");
  expect(html).toContain("Send me a code");
  expect(html).toContain("Continue with Google");
  expect(html).toContain("Continue with Cloudflare");
  // a wrong password goes back to the page with the reason, and makes no session
  const wrong = await postLogin({
    email: "Test-Login@directory.test",
    password: "not-the-password",
    next: "/sessions",
  });
  expect(wrong).toMatchObject({ status: 303 });
  const bounced = new URL(wrong.headers.get("location")!, ORIGIN);
  expect(bounced).toMatchObject({ pathname: "/login" });
  expect(bounced.searchParams.get("next")).toBe("/sessions");
  expect(bounced.searchParams.get("error")).toBeTruthy();
  expect(bounced.searchParams.get("method")).toBe("password");
  const retryPage = await exports.default
    .fetch(`${ORIGIN}/login${bounced.search}`)
    .then((r) => r.text());
  expect(retryPage).toContain("Test-Login@directory.test");
  expect(retryPage).toContain("That password");
  expect(wrong.headers.get("set-cookie") ?? "").not.toMatch(/__Host-itx-session=/);
  // the right one is the session — the email lowercased, the user created on first sign-in
  const login = await postLogin({
    email: "Test-Login@directory.test",
    password,
    next: "/sessions",
  });
  expect(login).toMatchObject({ status: 302 });
  expect(login.headers.get("location")).toBe("/sessions");
  const session = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Host-itx-session="))!;
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: session.split(";")[0]! },
  });
  expect(response).toMatchObject({ status: 101 });
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
  fetchReachesThisWorker();
  const email = "limited@directory.test";
  const errors: string[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const refused = await postLogin({ email, password: "wrong", next: "/" });
    expect(refused).toMatchObject({ status: 303 });
    errors.push(new URL(refused.headers.get("location")!, ORIGIN).searchParams.get("error") ?? "");
  }
  expect(errors.slice(0, 5).every((error) => error && !/too many/i.test(error))).toBe(true);
  expect(errors[5]).toMatch(/too many/i);
  const late = await postLogin({ email, password, next: "/" });
  expect(late).toMatchObject({ status: 303 });
  expect(new URL(late.headers.get("location")!, ORIGIN).searchParams.get("error")).toMatch(
    /too many/i,
  );
  // another address is untouched by that one's tries
  expect(await postLogin({ email: "unlimited@directory.test", password, next: "/" })).toMatchObject(
    {
      status: 302,
    },
  );
});

test("a control plane holder replaces the stub a deploy's reset broke; a refusal keeps it", async () => {
  // What a deploy does to a holder that outlives one call (rpc.ts: one per socket): workerd cuts the
  // in-flight call with `retryable: true`, and that stub fails every later call the same way.
  const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
    retryable: true,
    durableObjectReset: true,
  });
  const refusal = new Error("no such user");
  const broken = { projects: vi.fn(() => Promise.reject(reset)) };
  const fresh = {
    projects: vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve([]))
      .mockImplementationOnce(() => Promise.reject(refusal))
      .mockImplementationOnce(() => Promise.resolve([])),
  };
  const getByName = vi.fn().mockReturnValueOnce(broken).mockReturnValue(fresh);
  const controlPlane = new ControlPlane({
    getByName,
  } as unknown as DurableObjectNamespace<ControlPlaneDurableObject>);
  await expect(controlPlane.reachableProjects("every")).rejects.toBe(reset);
  await expect(controlPlane.reachableProjects("every")).resolves.toEqual([]);
  await expect(controlPlane.reachableProjects("every")).rejects.toBe(refusal);
  await expect(controlPlane.reachableProjects("every")).resolves.toEqual([]);
  // one stub at construction, one after the reset — none after the refusal
  expect(getByName).toHaveBeenCalledTimes(2);
  expect(broken.projects).toHaveBeenCalledTimes(1);
});

test("project ingress strips forged internal authority and never exposes platform credentials", async () => {
  const admin = await operator();
  using target = await admin.projects.create({ project: "directory-ingress" });
  await publishConfigWorker(target, ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const host = "https://echo--directory-ingress.projects.test/";
  const response = await exports.default.fetch(host, {
    headers: {
      "x-itx-principal": JSON.stringify({ actor: "admin" }),
      "x-itx-expression": "itx.append",
      "x-itx-rpc-stub-pager": encodeURIComponent(
        JSON.stringify({ rpcStubKey: "forged", appendEvents: [{ type: "forged" }] }),
      ),
      cookie: "__Host-itx-login=forged; theme=dark",
    },
  });
  expect(await response.json()).toEqual({
    principal: null,
    authorization: null,
    cookie: "theme=dark",
    routingSlug: "echo",
  });
  expect((await target.readEvents(0, 100)).events.some((event) => event.type === "forged")).toBe(
    false,
  );
  // the operator's bearer is /api's alone: a project host refuses it before any Durable Object,
  // so no app is ever handed an operator over every project (oauth.ts `authorizationForToken`)
  expect(
    await exports.default.fetch(host, { headers: { Authorization: `Bearer ${secret}` } }),
  ).toMatchObject({ status: 401 });
  expect(
    await exports.default.fetch(host, { headers: { Authorization: "Bearer unrecognized" } }),
  ).toMatchObject({ status: 401 });
  expect(await exports.default.fetch("https://unknown.projects.test/")).toMatchObject({
    status: 421,
  });
});

/** An admin session — `as` the person `email` names, when given — disposed when the test finishes. */
function operator(email?: string) {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  return adminSession(sessions, email);
}

/** `fetch` reaches this worker until the test finishes: the issuer fetches its own client metadata
 *  while it signs someone in, and the network is out of reach here. */
function fetchReachesThisWorker() {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => exports.default.fetch(new Request(input, init)));
  onTestFinished(() => {
    spy.mockRestore();
  });
}

/** The sign-in page's own post — same-ORIGIN, a form — with or without a browser's cookie. */
function postLogin(form: Record<string, string>, cookie?: string) {
  return exports.default.fetch(`${ORIGIN}/login`, {
    method: "POST",
    redirect: "manual",
    headers: cookie ? { Origin: ORIGIN, cookie } : { Origin: ORIGIN },
    body: new URLSearchParams(form),
  });
}

/** A read of the control-plane database — the `CONTROL_PLANE` singleton Durable Object's tables
 *  (src/control-plane/) — with no session between: `catalog("project", ref)`, `catalog("organization", orgId)`. */
function catalog(method: string, ...args: unknown[]) {
  return (controlPlaneStub() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
    method
  ]!(...args);
}

/** A global context's log, whole — the root's (the control plane's record), an organization's. */
async function globalLog(path: string) {
  return (
    (await stub(DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path })).invoke([
      "itx",
      ["readEvents", 0, 1000],
    ])) as { events: StreamEvent[] }
  ).events;
}

/** The person's account, folded (src/account/contract.ts) — read through their own context. */
async function accountState(session: Session) {
  return (
    (await session.user.invoke(["itx", "facets", ["get", "account"], ["snapshot"]])) as {
      state: AccountState;
    }
  ).state;
}

/** The organization's record, folded (src/organization/contract.ts) — read by membership. */
async function organizationState(session: Session, orgId: string) {
  return (
    (await (
      await session.organizations.get(orgId)
    ).invoke(["itx", "facets", ["get", "organization"], ["snapshot"]])) as {
      state: OrganizationState;
    }
  ).state;
}
