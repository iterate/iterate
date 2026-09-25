// __workers-tests__/admin-and-impersonation.test.ts — the platform admin (app-config.ts `admins`,
// wrangler.test.jsonc lists oauth-admin@example.com): the `admin` scope and signing a client in as
// someone else, through the real sign-in, consent, code exchange and admission.
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { platformAddressesOf } from "../src/app-config.ts";
import { authorizationForToken } from "../src/oauth.ts";
import {
  actingAs,
  authorizationRequest,
  call,
  fetchReachesThisWorker,
  helpers,
  issuerApprover,
  rpc,
} from "./oauth-support.ts";
import { controlPlane, loginPassword, ORIGIN, stub } from "./support.ts";

const ADMIN = "oauth-admin@example.com";
const addresses = platformAddressesOf(env, new Request(`${ORIGIN}/api`));

test("the admin scope: offered and granted to a listed address alone, every project as that person for 12 hours, only at /api, ended when the list drops them", async () => {
  fetchReachesThisWorker();
  const admin = await approverFor(ADMIN);
  const granted = await authorize(admin.approver, { scope: "iterate admin" });
  expect(granted.view).toMatchObject({ kind: "consent" });
  expect(
    granted.view.kind === "consent" && granted.view.scopes.map((scope) => scope.name),
  ).toContain("admin");
  expect(granted.scope?.split(" ")).toContain("admin");
  const authorization = await authorizationForToken(env, granted.token!, addresses, "api");
  expect(authorization).toMatchObject({
    principal: { actor: admin.user.id, email: ADMIN },
    reach: "every",
  });
  expect(authorization!.principal.impersonatedBy).toBeUndefined();
  const hours = (authorization!.grant!.deadline - Date.now()) / 3600_000;
  expect(hours).toBeGreaterThan(11.9);
  expect(hours).toBeLessThanOrEqual(12);
  // a project host would count its holder a member of every project
  expect(await authorizationForToken(env, granted.token!, addresses, "project-host")).toBeNull();
  // re-read at every admission: an address the list drops loses the grant at its next request
  expect(
    await authorizationForToken(listing(["someone@example.com"]), granted.token!, addresses, "api"),
  ).toBeNull();

  // the session's verbs: every person, and the global namespace walked like a project
  const { root } = await rpc(granted.token!);
  const other = await controlPlane().ensureUser("admin-scope-other@example.com");
  expect((await root.users.list()).map((user) => user.email)).toContain(other.email);
  using global = await root.global;
  using userContext = global.cd(`/users/${other.id}/../${other.id}`);
  expect(await userContext.invoke("itx.kv.get('admin-probe')")).toBeNull();
  await expect(Promise.resolve(global.cd("/projects/x"))).rejects.toThrow(/a global context is/);

  // for /mcp, no `admin`: the grant is the person's own
  const mcp = await authorize(admin.approver, { scope: "iterate admin", resource: addresses.mcp });
  expect(mcp.scope?.split(" ")).not.toContain("admin");

  // anyone else asking for it is offered nothing and granted their own reach
  const person = await approverFor("admin-scope-unlisted@example.com");
  using _project = await (
    await actingAs(person.user.email)
  ).projects.create({
    project: "admin-scope-unlisted",
  });
  const unlisted = await authorize(person.approver, { scope: "iterate admin" });
  expect(
    unlisted.view.kind === "consent" && unlisted.view.scopes.map((scope) => scope.name),
  ).not.toContain("admin");
  expect(unlisted.scope?.split(" ")).not.toContain("admin");
  const theirs = await authorizationForToken(env, unlisted.token!, addresses, "api");
  expect(theirs).toMatchObject({ reach: { userId: person.user.id } });
  const { root: theirRoot } = await rpc(unlisted.token!);
  await expect(Promise.resolve(theirRoot.global)).rejects.toThrow(/Only a platform admin/);
  // nor the operator acting as a person: every scope, but that person's reach
  const operatorAs = await actingAs(person.user.email);
  await expect(Promise.resolve(operatorAs.global)).rejects.toThrow(/Only a platform admin/);
});

test("signing a client in as someone: offered to an admin alone, the person's grant for an hour with the admin beside them on every event, audited on both accounts, marked in their Sessions, their own sign-ins untouched", async () => {
  fetchReachesThisWorker();
  const target = await approverFor("impersonated@example.com");
  using _project = await (
    await actingAs(target.user.email)
  ).projects.create({
    project: "impersonated",
  });
  const project = (await controlPlane().getProject("impersonated"))!;
  const own = await authorize(target.approver, { scope: "iterate account" });
  const admin = await approverFor(ADMIN);

  const signedIn = await authorize(admin.approver, {
    scope: "iterate account admin",
    impersonate: target.user.id,
  });
  // the ordinary consent page, with the picker's facts for the admin: whom, and who the client is
  expect(signedIn.view).toMatchObject({
    kind: "consent",
    email: ADMIN,
    impersonation: {
      resource: "API",
      redirectHost: "client.test",
      ownApp: false,
      scopes: [{ name: "iterate" }, { name: "account" }],
    },
  });
  expect(signedIn.view.kind === "consent" && signedIn.view.impersonation?.people).toContainEqual(
    target.user,
  );
  expect(signedIn.scope?.split(" ").sort()).toEqual(["account", "iterate"]);
  const authorization = await authorizationForToken(env, signedIn.token!, addresses, "api");
  expect(authorization).toMatchObject({
    principal: {
      actor: target.user.id,
      email: target.user.email,
      impersonatedBy: { actor: admin.user.id, email: ADMIN },
    },
    reach: { userId: target.user.id },
  });
  expect("projectIds" in (authorization!.reach as object)).toBe(false);
  const minutes = (authorization!.grant!.deadline - Date.now()) / 60_000;
  expect(minutes).toBeGreaterThan(59);
  expect(minutes).toBeLessThanOrEqual(60);
  // `revokeExistingGrants: false`: the person's own sign-in still works
  expect(await authorizationForToken(env, own.token!, addresses, "api")).toMatchObject({
    principal: { actor: target.user.id },
  });

  // what the session does is stamped with both people
  const { root } = await rpc(signedIn.token!);
  using context = await root.projects.get(project.id);
  const [appended] = await context.append({ type: "impersonation-probe" });
  expect(appended!.source?.principal).toEqual({
    actor: target.user.id,
    email: target.user.email,
    impersonatedBy: { actor: admin.user.id, email: ADMIN },
  });

  // the person's Sessions list the grant, marked with the admin
  const { root: theirs } = await rpc(own.token!);
  const grantId = authorization!.grant!.grantId;
  expect((await theirs.grants.list()).items.find((item) => item.id === grantId)).toMatchObject({
    impersonatedBy: ADMIN,
  });

  // both accounts record it, with the grant's id, the admin the principal of each record
  const started = (await accountEvents(target.user.id)).find(
    (event) => event.type === "events.iterate.com/account/impersonation-started",
  );
  const record = {
    payload: {
      grantId,
      target: { userId: target.user.id, email: target.user.email },
      impersonatedBy: { actor: admin.user.id, email: ADMIN },
      clientName: "Admin integration",
      resource: "api",
      scopes: ["iterate", "account"],
      projects: null,
    },
    source: { principal: { actor: admin.user.id, email: ADMIN }, platform: true },
  };
  expect(started).toMatchObject(record);
  const performed = (await accountEvents(admin.user.id)).find(
    (event) => event.type === "events.iterate.com/account/impersonation-performed",
  );
  expect(performed).toMatchObject(record);
  // the grant's own use is stamped with both people too
  const used = (await accountEvents(target.user.id)).find(
    (event) =>
      event.type === "events.iterate.com/account/grant-used" &&
      (event.payload as { grantId: string }).grantId === grantId,
  );
  expect(used?.source?.principal).toMatchObject({ impersonatedBy: { actor: admin.user.id } });

  // the admin leaving the list ends it at its next request
  expect(
    await authorizationForToken(
      listing(["someone@example.com"]),
      signedIn.token!,
      addresses,
      "api",
    ),
  ).toBeNull();

  // for /mcp too, the person's reach: the `admin` rule is the only one /mcp adds
  const mcp = await authorize(admin.approver, {
    scope: "iterate admin",
    resource: addresses.mcp,
    impersonate: target.user.id,
  });
  expect(mcp.view).toMatchObject({ impersonation: { resource: "MCP" } });
  expect(mcp).toMatchObject({ scope: "iterate" });

  // the person ending it in their Sessions ends it, refresh included
  await theirs.grants.end(grantId);
  expect(await authorizationForToken(env, signedIn.token!, addresses, "api")).toBeNull();
  expect(await refresh(signedIn)).toMatchObject({ status: 400 });

  // anyone but an admin is offered nothing and refused when they post it anyway
  const refused = await authorize(target.approver, {
    scope: "iterate",
    impersonate: admin.user.id,
  });
  expect(refused.view.kind === "consent" && refused.view.impersonation).toBeUndefined();
  expect(refused.error).toMatch(/Only a platform admin/);
  // …and the consent form itself takes no post without the page's own Origin
  const noOrigin = await call(`/oauth2/auth?client_id=x`, {
    method: "POST",
    body: new URLSearchParams({ impersonate: target.user.id }),
  });
  expect(noOrigin).toMatchObject({ status: 403 });
  // and nobody is named through the authorization URL: `act_as` there is an unknown parameter
  const named = await authorize(target.approver, { scope: "iterate", actAs: ADMIN });
  expect(named.view).toMatchObject({ kind: "consent", email: target.user.email });
  expect(await authorizationForToken(env, named.token!, addresses, "api")).toMatchObject({
    principal: { actor: target.user.id },
  });
});

test("an impersonation's access token never outlives its hour: a code exchanged late gets a token that ends with it", async () => {
  fetchReachesThisWorker();
  const target = await approverFor("impersonated-late@example.com");
  const admin = await approverFor(ADMIN);
  // nine minutes on (the code lives ten): 51 minutes of the hour are left, not the token's usual 60
  const late = await authorize(admin.approver, {
    scope: "iterate",
    impersonate: target.user.id,
    exchangeAfterMs: 9 * 60_000,
  });
  expect(late.expiresIn).toBeLessThanOrEqual(51 * 60 + 1);
  const authorization = await authorizationForToken(env, late.token!, addresses, "api");
  expect(authorization!.grant!.expiresAt).toBeLessThanOrEqual(authorization!.grant!.deadline);
});

test("a client on a project's host signed in as someone is bound to that project, as the person's own sign-in would be", async () => {
  fetchReachesThisWorker();
  const target = await approverFor("impersonated-host@example.com");
  using hostProject = await (
    await actingAs(target.user.email)
  ).projects.create({ project: "impersonated-host" });
  const projectId = (await hostProject.whoami()).projectId;
  await controlPlane().claimHostname(projectId, "impersonated-host.test");
  const admin = await approverFor(ADMIN);
  const { query } = await authorizationRequest("https://impersonated-host.test/.auth/client.json", [
    addresses.api,
  ]);
  query.set("redirect_uri", "https://impersonated-host.test/.auth/callback");
  const view = await admin.approver.consent.describe(`?${query}`);
  expect(view).toMatchObject({ projectBound: true, impersonation: { ownApp: false } });
  const approval = await admin.approver.consent.approve({
    query: `?${query}`,
    projects: [],
    impersonate: target.user.id,
  });
  expect(approval).toHaveProperty("redirectTo");
  const started = (await accountEvents(target.user.id)).find(
    (event) => event.type === "events.iterate.com/account/impersonation-started",
  );
  expect(started).toMatchObject({ payload: { projects: [projectId] } });
});

/** Everything on `userId`'s account log. */
async function accountEvents(userId: string) {
  return (
    (await stub(`global.iterate/users/${userId}`).invoke(["itx", ["readEvents", 0, 500]])) as {
      events: StreamEvent[];
    }
  ).events;
}

/** The consent capability of `email`'s issuer session, signed in with the password. */
async function approverFor(email: string) {
  const login = await call("/login", {
    method: "POST",
    body: new URLSearchParams({ email, password: loginPassword(), next: "/" }),
  });
  const approver = await issuerApprover(login.headers.get("set-cookie")!.split(";")[0]!);
  return { approver, user: await controlPlane().ensureUser(email) };
}

/** A client's authorization for `scope` on `resource` (`act_as` in its query when given), approved
 *  by `approver` with every project — or as the person `impersonate` names — and its code
 *  exchanged: the access token, or the refusal. */
async function authorize(
  approver: Awaited<ReturnType<typeof approverFor>>["approver"],
  input: {
    scope: string;
    resource?: string;
    actAs?: string;
    impersonate?: string;
    /** how long after approval the code is exchanged */
    exchangeAfterMs?: number;
  },
) {
  const client = await helpers().createClient({
    clientName: "Admin integration",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const { query, verifier } = await authorizationRequest(client.clientId, [
    input.resource || addresses.api,
  ]);
  query.set("scope", input.scope);
  if (input.actAs) query.set("act_as", input.actAs);
  const view = await approver.consent.describe(`?${query}`);
  const approval = await approver.consent.approve({
    query: `?${query}`,
    projects: ["*"],
    impersonate: input.impersonate,
  });
  if ("error" in approval) return { view, error: approval.error };
  const code = new URL(approval.redirectTo).searchParams.get("code")!;
  const now = Date.now();
  const clock = input.exchangeAfterMs
    ? vi.spyOn(Date, "now").mockImplementation(() => now + input.exchangeAfterMs!)
    : null;
  const response = await call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.clientId,
      redirect_uri: "https://client.test/callback",
      code_verifier: verifier,
    }),
  });
  clock?.mockRestore();
  const token = await response.json<{
    access_token: string;
    refresh_token: string;
    scope: string;
    expires_in: number;
  }>();
  expect(response, JSON.stringify(token)).toMatchObject({ status: 200 });
  return {
    view,
    clientId: client.clientId,
    token: token.access_token,
    refreshToken: token.refresh_token,
    scope: token.scope,
    expiresIn: token.expires_in,
  };
}

/** A refresh of `granted`'s tokens at the token endpoint. */
function refresh(granted: { clientId?: string; refreshToken?: string }) {
  return call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: granted.refreshToken!,
      client_id: granted.clientId!,
    }),
  });
}

/** The deployment's `admins` as `list` names them, for one admission. */
function listing(list: string[]) {
  return { ...env, APP_CONFIG_ADMINS: JSON.stringify(list) } as typeof env;
}
