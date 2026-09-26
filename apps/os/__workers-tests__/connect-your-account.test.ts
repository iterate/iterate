// __workers-tests__/connect-your-account.test.ts — A PERSON'S OWN ACCOUNT CONNECTED TO A PROJECT: their
// Google connection (connected on their own context through the pet shop's fake, as a sign-in keeps
// one) picked on the project with `itx.integrations.connect("google", { account })`. Holding the
// scopes the project asks for, it is connected at once, with no provider round-trip; lacking some,
// Google is asked to add them on the person's own connection and the callback connects it. The
// project's path is a pointer: each use is forwarded to the person's secret, which dispatches and
// refreshes it. Disconnecting it from the project, the project deleting its path, the person
// disconnecting their account and the person leaving the organization each end the project's use (a
// 502) and drop its row; only the first three leave the person's own connection standing where they
// did not end it themselves. Only the person themselves attaches their account — their own grant
// holding the `account` scope — and only what the provider granted counts. Every multi-object step
// converges on a retry.
import { newWebSocketRpcSession } from "capnweb";
import { codedError } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import { exports } from "cloudflare:workers";
import { expect, onTestFinished, test } from "vitest";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import type { IntegrationScope } from "../src/integrations/connections.ts";
import { disconnectIntegration } from "../src/integrations/verbs.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import {
  adminSession,
  followConsent,
  ORIGIN,
  petshopFakes,
  projectWithMember,
  refused,
  readLog,
  signedInMember,
  stub,
  until,
} from "./support.ts";

test("a project connects your Google account in one click: its uses run through your connection, refreshed there, and disconnecting it from the project leaves it yours", async () => {
  const member = await projectWithMember("connect-yours");
  const petshop = petshopFakes();
  const { connection, path } = await personalGoogle(petshop, member, "ada@example.test");
  const { actor } = await member.session.whoami();
  // no authorizationUrl: the account already holds what the project asks for
  expect(await member.itx.integrations.connect("google", { account: "ada@example.test" })).toEqual({
    connection,
  });
  expect(await projectRow(member, connection)).toMatchObject({
    provider: "google",
    client: "iterate",
    account: "ada@example.test",
    ownerUserId: actor,
    ownerEmail: "connect-yours@example.test",
    scopes: expect.arrayContaining(["https://www.googleapis.com/auth/gmail.modify"]),
  });
  expect(await gmailProfile(member.itx, path)).toMatchObject({
    status: 200,
    body: { emailAddress: "ada@example.test" },
  });
  // an expired token is refreshed at the person's connection, through iterate's client
  await petshop.state.expireAccessTokens("petshop-default");
  expect(await gmailProfile(member.itx, path)).toMatchObject({ status: 200 });
  const uses = (await personalLog(member, path)).filter(
    (event) => event.type === "events.iterate.com/secret/used",
  );
  expect(uses.at(-1)?.payload).toMatchObject({ status: 200, borrower: member.projectId });
  // connected again: the one pointer stands
  await member.itx.integrations.connect("google", { account: "ada@example.test" });
  expect(Object.values(await personalLends(member, path))).toHaveLength(1);

  await member.itx.facets.get("project").disconnectIntegration({ provider: "google", connection });
  expect(await gmailProfile(member.itx, path)).toMatchObject({ status: 502 });
  await until("the project's row dropped", async () => !(await projectRow(member, connection)));
  expect(await personalRow(member, connection)).toMatchObject({ account: "ada@example.test" });
  expect(await personalLends(member, path)).toEqual({});
  expect(await ended(member, path)).toEqual(["borrower-deleted"]);
  // the person's own egress still uses it
  expect(await gmailProfile(member.session.user, path)).toMatchObject({ status: 200 });
});

test("an account lacking what the project asks for: Google is asked to add it on your own connection, and the callback connects it to the project", async () => {
  const member = await projectWithMember("connect-more");
  const petshop = petshopFakes();
  const { connection, path } = await personalGoogle(petshop, member, "ben@example.test");
  const extra = "https://www.googleapis.com/auth/contacts.readonly";
  const { authorizationUrl, ...answer } = await member.itx.integrations.connect("google", {
    account: "ben@example.test",
    scopes: [extra],
    next: `${ORIGIN}/back`,
  });
  expect(answer).toEqual({ connection });
  const consent = new URL(authorizationUrl);
  expect(Object.fromEntries(consent.searchParams)).toMatchObject({
    login_hint: "ben@example.test",
    include_granted_scopes: "true",
    scope: expect.stringContaining(extra),
  });
  // not connected to the project until the consent comes back
  expect(await projectRow(member, connection)).toBeUndefined();
  const back = await followConsent(
    petshop,
    `${authorizationUrl}&email=ben@example.test`,
    member.cookie,
  );
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(back.headers.get("location")).toBe(`${ORIGIN}/back`);
  expect(await until("the project's row", () => projectRow(member, connection))).toMatchObject({
    ownerUserId: expect.any(String),
    account: "ben@example.test",
    scopes: expect.arrayContaining([extra, "https://www.googleapis.com/auth/gmail.modify"]),
  });
  expect(await personalRow(member, connection)).toMatchObject({
    scopes: expect.arrayContaining([extra]),
  });
  expect(await gmailProfile(member.itx, path)).toMatchObject({
    status: 200,
    body: { emailAddress: "ben@example.test" },
  });
});

test("the project deleting its path, or the person disconnecting their account, ends the project's use and drops its row", async () => {
  const member = await projectWithMember("connect-ends");
  const petshop = petshopFakes();
  const first = await personalGoogle(petshop, member, "cat@example.test");
  await member.itx.integrations.connect("google", { account: "cat@example.test" });
  await member.itx.secrets.delete(first.path);
  await until(
    "the row dropped on delete",
    async () => !(await projectRow(member, first.connection)),
  );
  expect(await ended(member, first.path)).toEqual(["borrower-deleted"]);

  await member.itx.integrations.connect("google", { account: "cat@example.test" });
  expect(await gmailProfile(member.itx, first.path)).toMatchObject({ status: 200 });
  await member.session.user.facets
    .get("account")
    .disconnectIntegration({ provider: "google", connection: first.connection });
  expect(await gmailProfile(member.itx, first.path)).toMatchObject({ status: 502 });
  await until(
    "the row dropped on the person's disconnect",
    async () => !(await projectRow(member, first.connection)),
  );
  expect(await personalRow(member, first.connection)).toBeUndefined();
});

test("a person removed from the project's organization: the project's use of their account ends, and its row goes", async () => {
  const owner = await projectWithMember("connect-org");
  const bob = await signedInMember("bob-connects@example.test");
  // after every sign-in: signing in restores `fetch`
  const petshop = petshopFakes();
  const [organization] = await owner.session.organizations.list();
  await owner.session.organizations.addMember(organization.id, {
    userId: "bob-connects@example.test",
  });
  const { connection, path } = await personalGoogle(petshop, bob, "bob@example.test");
  const bobsProject = await bob.session.projects.get(owner.projectId);
  await bobsProject.integrations.connect("google", { account: "bob@example.test" });
  expect(await gmailProfile(owner.itx, path)).toMatchObject({ status: 200 });
  await owner.session.organizations.removeMember(organization.id, {
    userId: "bob-connects@example.test",
  });
  expect(await gmailProfile(owner.itx, path)).toMatchObject({ status: 502 });
  expect(await ended(bob, path)).toEqual(["membership-ended"]);
  await until("the row dropped", async () => !(await projectRow(owner, connection)));
  expect(await personalRow(bob, connection)).toMatchObject({ account: "bob@example.test" });
});

test("only your own accounts, only by you: another member's account, an admin acting on a project and a project with its own secret at the path are refused, and nobody lends a person's secret by hand", async () => {
  const owner = await projectWithMember("connect-refusals");
  const dee = await signedInMember("dee-connects@example.test");
  const petshop = petshopFakes();
  const [organization] = await owner.session.organizations.list();
  await owner.session.organizations.addMember(organization.id, {
    userId: "dee-connects@example.test",
  });
  const dees = await personalGoogle(petshop, dee, "dee@example.test");
  // the owner names Dee's account: it is not among their own
  await refused(
    () => owner.itx.integrations.connect("google", { account: "dee@example.test" }),
    "INVALID_INPUT",
    /you have no google account dee@example.test/,
  );
  // the operator on the project is no person
  const sessions: Disposable[] = [];
  const operator = await adminSession(sessions);
  await refused(
    () =>
      operator.projects
        .get(owner.projectId)
        .integrations.connect("google", { account: "dee@example.test" }),
    "FORBIDDEN",
  );
  // the operator signed in as the owner is no one's own grant: refused as well
  const operatorAsOwner = await adminSession(sessions, "connect-refusals@example.test");
  await refused(
    () =>
      operatorAsOwner.projects
        .get(owner.projectId)
        .integrations.connect("google", { account: "dee@example.test" }),
    "FORBIDDEN",
  );
  // the operator on Dee's own context can neither finish a connect nor aim one at a project
  const deesRoot = operator.global.cd(`/users/${(await dee.session.whoami()).actor}`);
  await expect(
    deesRoot.facets.get("account").invoke([
      [
        "finishIntegrationConnect",
        {
          provider: "google",
          connection: dees.connection,
          nonce: "n",
          grantedScopes: [],
          consentedBy: { person: true },
        },
      ],
    ]),
  ).rejects.toThrow();
  for (const session of sessions) session[Symbol.dispose]();
  // a project path holding a secret of its own is never replaced by a pointer
  await owner.itx.secrets.set(dees.path, "own", { urls: ["https://google.test"] });
  const deesProject = await dee.session.projects.get(owner.projectId);
  await expect(
    deesProject.integrations.connect("google", { account: "dee@example.test" }),
  ).rejects.toThrow(/a secret of its own/);
  expect(await personalLends(dee, dees.path)).toEqual({});
  // the pointer's verbs are the platform's, and a person's secret is no one's to lend by hand
  await expect(
    dee.session.user.secrets.lend(dees.path, { to: owner.projectId, as: "/secrets/g" }),
  ).rejects.toThrow(/the deployment's own secrets/);
  await expect(
    owner.itx.secrets.connectToProject(dees.path, {
      projectId: owner.projectId,
      connection: await personalRow(dee, dees.connection),
    }),
  ).rejects.toThrow(/the platform's own/);
  await expect(
    owner.itx.secrets.acceptLend("/secrets/forged", {
      lendId: "lend_x",
      lender: { userId: "user_x" },
      lenderContext: "x",
      lenderPath: "/secrets/x",
      urls: ["https://google.test"],
    }),
  ).rejects.toThrow(/the platform's own/);
});

test("a key bound to projects connects no account of the person's, even to a project it reaches", async () => {
  const member = await projectWithMember("connect-pat");
  const petshop = petshopFakes();
  await personalGoogle(petshop, member, "pat@example.test");
  const { token } = await member.session.grants.mint({
    name: "script",
    projects: [member.projectId],
  });
  const keyed = (await bareSocket()).authenticate({ type: "bearer", token });
  await refused(
    () =>
      keyed.projects
        .get(member.projectId)
        .integrations.connect("google", { account: "pat@example.test" }),
    "FORBIDDEN",
    /signed in with access to their account/,
  );
  expect(await projectRow(member, (await personalRows(member))[0]!.connection)).toBeUndefined();
});

test("a consent the person narrowed connects nothing the project needs: the account records what Google granted, and the project is not connected", async () => {
  const member = await projectWithMember("connect-narrowed");
  const petshop = petshopFakes();
  const { connection } = await personalGoogle(petshop, member, "nia@example.test");
  const extra = "https://www.googleapis.com/auth/contacts.readonly";
  const { authorizationUrl } = await member.itx.integrations.connect("google", {
    account: "nia@example.test",
    scopes: [extra],
    next: `${ORIGIN}/back`,
  });
  // the person unticks everything but their identity on Google's screen
  const narrowed = new URL(authorizationUrl);
  narrowed.searchParams.set("scope", "openid email profile");
  const callback = await platformCallbackOf(petshop, `${narrowed.href}&email=nia@example.test`);
  // the callback refuses, and a refresh of it refuses again: never a quiet success
  for (const _attempt of [1, 2]) {
    const back = await exports.default.fetch(
      new Request(callback, { headers: { cookie: member.cookie }, redirect: "manual" }),
    );
    expect({ status: back.status, text: await back.text() }).toMatchObject({
      status: 400,
      text: expect.stringContaining("did not grant"),
    });
  }
  expect(await personalRow(member, connection)).toMatchObject({
    scopes: ["openid", "email", "profile"],
  });
  expect(await connectedFacts(member.projectId)).toEqual([]);
});

test("an attach runs once per consent: a refresh after one that began attaches nothing, even once the project could take it", async () => {
  const member = await projectWithMember("connect-once");
  const petshop = petshopFakes();
  const { connection, path } = await personalGoogle(petshop, member, "one@example.test");
  // the project's path holds a secret of its own, so the first attach is refused
  await member.itx.secrets.set(path, "own", { urls: ["https://google.test"] });
  const { authorizationUrl } = await member.itx.integrations.connect("google", {
    account: "one@example.test",
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    next: `${ORIGIN}/back`,
  });
  const callback = await platformCallbackOf(petshop, `${authorizationUrl}&email=one@example.test`);
  const refreshed = () =>
    exports.default.fetch(
      new Request(callback, { headers: { cookie: member.cookie }, redirect: "manual" }),
    );
  expect(await refreshed()).toMatchObject({ status: 400 });
  await member.itx.secrets.delete(path);
  const again = await refreshed();
  expect({ status: again.status, text: await again.text() }).toMatchObject({
    status: 400,
    text: expect.stringContaining("did not finish"),
  });
  expect(await projectRow(member, connection)).toBeUndefined();
  expect(await connectedFacts(member.projectId)).toEqual([]);
});

test("two callbacks for one consent at once attach the account once: the second never connects it again", async () => {
  const member = await projectWithMember("connect-twice");
  const petshop = petshopFakes();
  const { connection } = await personalGoogle(petshop, member, "two@example.test");
  const { authorizationUrl } = await member.itx.integrations.connect("google", {
    account: "two@example.test",
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    next: `${ORIGIN}/back`,
  });
  const callback = await platformCallbackOf(petshop, `${authorizationUrl}&email=two@example.test`);
  const finish = () =>
    exports.default.fetch(
      new Request(callback, { headers: { cookie: member.cookie }, redirect: "manual" }),
    );
  const answers = await Promise.all([finish(), finish()]);
  expect(answers.map((answer) => answer.status)).toContain(303);
  expect(await connectedFacts(member.projectId)).toHaveLength(1);
  expect(await until("the project's row", () => projectRow(member, connection))).toMatchObject({
    account: "two@example.test",
  });
});

test("a person's disconnect of their account that could not tell a project fails, and done again, the project stops using it", async () => {
  const member = await projectWithMember("connect-retry-end");
  const petshop = petshopFakes();
  const { connection, path } = await personalGoogle(petshop, member, "ret@example.test");
  await member.itx.integrations.connect("google", { account: "ret@example.test" });
  const projectPath = stub(`${member.projectId}.iterate${path}`);
  await projectPath.append({ type: "events.iterate.com/itx/paused", payload: { reason: "test" } });
  const account = member.session.user.facets.get("account");
  await expect(account.disconnectIntegration({ provider: "google", connection })).rejects.toThrow(
    /paused/,
  );
  await projectPath.append({ type: "events.iterate.com/itx/resumed", payload: {} });
  await account.disconnectIntegration({ provider: "google", connection });
  await until("the project's row dropped", async () => !(await projectRow(member, connection)));
  expect(await personalRow(member, connection)).toBeUndefined();
  expect(await gmailProfile(member.itx, path)).toMatchObject({ status: 502 });
});

test("a project that disconnects the account while more access is being asked for stays disconnected when the consent comes back", async () => {
  const member = await projectWithMember("connect-cancel");
  const petshop = petshopFakes();
  const { connection } = await personalGoogle(petshop, member, "cal@example.test");
  await member.itx.integrations.connect("google", { account: "cal@example.test" });
  const { authorizationUrl } = await member.itx.integrations.connect("google", {
    account: "cal@example.test",
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    next: `${ORIGIN}/back`,
  });
  await member.itx.facets.get("project").disconnectIntegration({ provider: "google", connection });
  const back = await followConsent(
    petshop,
    `${authorizationUrl}&email=cal@example.test`,
    member.cookie,
  );
  expect(back).toMatchObject({ status: 303 });
  // connected once, disconnected once: the consent that came back connected nothing
  expect(await connectedFacts(member.projectId)).toHaveLength(1);
  expect(await projectRow(member, connection)).toBeUndefined();
});

test("a finish replayed for an earlier consent never connects the project a later consent on the same account is for", async () => {
  const member = await projectWithMember("connect-nonce");
  const petshop = petshopFakes();
  const { connection } = await personalGoogle(petshop, member, "noe@example.test");
  const other = await member.session.projects.create({ project: "connect-nonce-other" });
  const { projectId: otherId } = await other.whoami();
  const first = await member.itx.integrations.connect("google", {
    account: "noe@example.test",
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    next: `${ORIGIN}/back`,
  });
  const back = await followConsent(
    petshop,
    `${first.authorizationUrl}&email=noe@example.test`,
    member.cookie,
  );
  expect(back).toMatchObject({ status: 303 });
  // a second consent on the same account, for the other project, still in flight
  await other.integrations.connect("google", {
    account: "noe@example.test",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    next: `${ORIGIN}/back`,
  });
  // the first consent's finish, again: its attempt is spent, so it connects nothing
  const { actor } = await member.session.whoami();
  await stub(
    DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path: `/users/${actor}` }),
  ).invoke(
    [
      "itx",
      "builtins",
      "integrations",
      [
        "finishConnect",
        {
          provider: "google",
          connection,
          nonce: nonceOf(first.authorizationUrl!),
          grantedScopes: [],
          consentedBy: { person: true },
        },
      ],
    ],
    [],
    { principal: null, platform: true },
  );
  expect(await connectedFacts(otherId)).toEqual([]);
});

test("a pointer whose lender-side fact was lost converges on the retry: one lend, its facts once", async () => {
  const member = await projectWithMember("connect-converge");
  const petshop = petshopFakes();
  const { path } = await personalGoogle(petshop, member, "cor@example.test");
  const secret = stub(await personalSecretName(member, path));
  await secret.append({ type: "events.iterate.com/itx/paused", payload: { reason: "test" } });
  await expect(
    member.itx.integrations.connect("google", { account: "cor@example.test" }),
  ).rejects.toThrow(/paused/);
  await secret.append({ type: "events.iterate.com/itx/resumed", payload: {} });
  await member.itx.integrations.connect("google", { account: "cor@example.test" });
  expect(Object.values(await personalLends(member, path))).toHaveLength(1);
  expect(await factsOf(await personalSecretName(member, path), "secret/lent")).toHaveLength(1);
  expect(await factsOf(`${member.projectId}.iterate${path}`, "secret/borrowed")).toHaveLength(1);
  expect(await gmailProfile(member.itx, path)).toMatchObject({ status: 200 });
});

test("a pointer's end whose fact was lost converges on the retry: the fact lands once, the row goes, the pointer with it", async () => {
  const member = await projectWithMember("connect-drop");
  const petshop = petshopFakes();
  const { connection, path } = await personalGoogle(petshop, member, "dru@example.test");
  await member.itx.integrations.connect("google", { account: "dru@example.test" });
  const [row] = (await member.itx.secrets.list()).filter(
    (secret: { path: string }) => secret.path === path,
  );
  const lendId = row.borrowed.lendId as string;
  const borrowedPath = stub(`${member.projectId}.iterate${path}`);
  const dropLend = () =>
    stub(member.projectId).invoke(
      ["itx", "builtins", "secrets", ["dropLend", path, { lendId, reason: "lender" }]],
      [],
      { principal: null, platform: true },
    );
  await borrowedPath.append({ type: "events.iterate.com/itx/paused", payload: { reason: "test" } });
  await refused(dropLend, "STREAM_PAUSED");
  await borrowedPath.append({ type: "events.iterate.com/itx/resumed", payload: {} });
  await dropLend();
  expect(await factsOf(`${member.projectId}.iterate${path}`, "secret/lend-revoked")).toHaveLength(
    1,
  );
  await until("the row dropped", async () => !(await projectRow(member, connection)));
  expect(await gmailProfile(member.itx, path)).toMatchObject({ status: 502 });
});

test("disconnecting a person's account from a project fails loudly unless the pointer is already gone", async () => {
  const appended: unknown[] = [];
  const row = {
    provider: "google" as const,
    connection: "c",
    client: "iterate" as const,
    account: "x@example.test",
    externalId: "1",
    ownerUserId: "usr_x",
  };
  const scopeFailing = (error: Error) =>
    ({
      env: { ITERATE_CONTEXT: { getByName: () => ({ invoke: async () => appended.push(1) }) } },
      projectId: "prj_x",
      rootPath: "/",
      withItx: async () => {
        throw error;
      },
      storage: {},
    }) as unknown as IntegrationScope;
  const input = { provider: "google" as const, connection: "c" };
  const integrations = { "/integrations/google/c": row };
  await expect(
    disconnectIntegration(scopeFailing(new Error("unreachable")), integrations, input),
  ).rejects.toThrow("unreachable");
  expect(appended).toEqual([]);
  await disconnectIntegration(
    scopeFailing(codedError("SECRET_NOT_SET", "never set")),
    integrations,
    input,
  );
  expect(appended).toHaveLength(1);
});

type Member = { session: any; cookie: string };

/** The person's own Google connection, connected on their context through the fake with iterate's
 *  client's scopes (a sign-in's, on this suite): its name and its secret's path under their root. */
async function personalGoogle(
  petshop: ReturnType<typeof petshopFakes>,
  member: Member,
  email: string,
): Promise<{ connection: string; path: string }> {
  const { authorizationUrl, connection } = await member.session.user.integrations.connect(
    "google",
    { next: `${ORIGIN}/` },
  );
  const back = await followConsent(petshop, `${authorizationUrl}&email=${email}`, member.cookie);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(await personalRow(member, connection)).toMatchObject({ account: email });
  return { connection, path: `/secrets/google-${connection}` };
}

async function gmailProfile(itx: any, path: string) {
  const response: Response = await itx.fetch(
    new Request("https://google.test/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer getSecret("${path}", { field: "accessToken" })` },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: response.ok ? JSON.parse(text) : text };
}

/** The project's row for the connection, or undefined. */
async function projectRow(member: { itx: any }, connection: string) {
  const { state } = await member.itx.facets.get("project").snapshot();
  return state.integrations[`/integrations/google/${connection}`];
}

/** The person's own row for the connection, or undefined. */
async function personalRow(member: Member, connection: string) {
  const { state } = await member.session.user.facets.get("account").snapshot();
  return state.integrations[`/integrations/google/${connection}`];
}

/** The live lends of the person's secret at `path`, as their catalog folds them. */
async function personalLends(member: Member, path: string) {
  const { state } = await member.session.user.facets.get("account").snapshot();
  return state.secrets[path]?.lends ?? {};
}

/** The person's secret's own log. */
async function personalLog(member: Member, path: string): Promise<StreamEvent[]> {
  return readLog(await personalSecretName(member, path));
}

/** Why each project's use of the person's secret ended, as their secret recorded it. */
async function ended(member: Member, path: string) {
  return (await personalLog(member, path))
    .filter((event) => event.type === "events.iterate.com/secret/lend-revoked")
    .map((event) => (event.payload as { reason: string }).reason);
}

/** The person's own rows. */
async function personalRows(member: Member): Promise<{ connection: string }[]> {
  const { state } = await member.session.user.facets.get("account").snapshot();
  return Object.values(state.integrations);
}

/** The person's secret's context name. */
async function personalSecretName(member: Member, path: string) {
  const { actor } = await member.session.whoami();
  return DurableObjectNameCodec.stringify({
    projectId: GLOBAL_PROJECT_ID,
    path: `/users/${actor}${path}`,
  });
}

/** The facts of one type on a context's log. */
async function factsOf(name: string, type: string): Promise<StreamEvent[]> {
  return (await readLog(name)).filter((event) => event.type === `events.iterate.com/${type}`);
}

/** Every `google/connected` on a project's root. */
function connectedFacts(projectId: string) {
  return factsOf(projectId, "google/connected");
}

/** The OAuth attempt's nonce, off the authorize URL's signed state (caller.ts `signClaims`). */
function nonceOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state")!;
  const payload = state.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return (JSON.parse(atob(padded)) as { nonce: string }).nonce;
}

/** `/api` opened bare: it authenticates in-band. */
async function bareSocket() {
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
  });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  onTestFinished(() => {
    transport[Symbol.dispose]();
  });
  return transport;
}

/** The platform callback a provider's consent at `url` sends the browser to: the pet shop's hops
 *  followed, the platform's not taken. */
async function platformCallbackOf(
  petshop: ReturnType<typeof petshopFakes>,
  url: string,
): Promise<string> {
  for (let hop = 0; hop < 8; hop++) {
    const response =
      (await petshop.handle(new Request(url, { redirect: "manual" }))) ??
      new Response("Not Found", { status: 404 });
    const next = new URL(response.headers.get("location")!, url);
    if (next.origin === ORIGIN) return next.href;
    url = next.href;
  }
  throw new Error(`platformCallbackOf: still at the provider at ${url}`);
}
