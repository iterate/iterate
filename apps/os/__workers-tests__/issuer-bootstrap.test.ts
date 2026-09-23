import { env, SELF, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { appSession, startAppSession } from "iterate/next/app-server";
import { authorizationCodeRequest } from "iterate/next/oauth";
import { platformAddressesOf } from "../src/app-config.ts";
import type { Env } from "../src/env.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { startIssuerSession } from "../src/issuer-session.ts";
import { oauthHelpers, parseAuthorization } from "../src/oauth.ts";
import { controlPlaneStub } from "./support.ts";

const bindings = env as unknown as Env;
const origin = "https://control.test";
const sessions: Disposable[] = [];
beforeEach(() => {
  // DNS transport only. Provider metadata, PKCE, exchange, storage and API are real.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
});
afterEach(() => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]();
  vi.restoreAllMocks();
});
async function connect(headers: Record<string, string>) {
  const response = await SELF.fetch(`${origin}/api`, {
    headers: { ...headers, Upgrade: "websocket" },
  });
  expect(response.status, response.status === 101 ? "" : await response.text()).toBe(101);
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(transport);
  return transport.authenticate({ type: "from-server-cookie" });
}
/** A bare `/api` socket authenticated in-band with the admin secret — the operator, or `as` a
 *  person (src/session.ts): how a fixture makes a user, or acts as one before they have signed in. */
async function operator(email?: string) {
  const response = await SELF.fetch(`${origin}/api`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(transport);
  return transport.authenticate({
    type: "admin-secret",
    secret: bindings.APP_CONFIG_SECRETS__ADMIN_BEARER!,
    ...(email && { as: { email } }),
  });
}
/** The person `email` names, found or created by the control plane — what an issuer session is
 *  started for (the sign-in's own find-or-create). */
const person = async (email: string) => (await operator()).users.create({ email });

test("first consent creates organization and project through the ordinary session, then grants only the chosen project", async () => {
  const user = await (
    await operator()
  ).users.linkIdentity({
    provider: "google",
    subject: "1357924680",
    email: "bootstrap@example.com",
  });
  const helpers = oauthHelpers(bindings, platformAddressesOf(bindings, new Request(`${origin}/`)));
  const client = await helpers.createClient({
    clientName: "Claude fixture",
    clientUri: "https://studio.example/about",
    logoUri: "https://images.example/studio.svg",
    redirectUris: ["http://127.0.0.1/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: client.clientId,
    redirectUri: "http://127.0.0.1:12345/callback",
    resources: [`${origin}/mcp`],
  });
  const next = flow.url.pathname + flow.url.search;
  // the picture Google's sign-in brings rides the issuer grant to the consent page's "signed in as"
  const picture = "https://lh3.googleusercontent.com/a/bootstrap=s96-c";
  const login = await startIssuerSession(bindings, new Request(origin), user, next, { picture });
  expect(login.location).toBe(next);
  expect(login.setCookie).toMatch(/^__Host-itx-session=[\da-f-]+; HttpOnly; Secure;/);
  const headers = { Cookie: login.setCookie.split(";")[0]!, Origin: origin };
  const api = await connect(headers);
  expect((await api.info()).principal).toEqual({ actor: user.id, email: user.email });
  expect(await api.organizations.list()).toEqual([]);
  expect(await api.projects.list()).toEqual([]);
  expect(await api.consent.describe(flow.url.search)).toMatchObject({
    kind: "consent",
    clientName: "Claude fixture",
    clientId: client.clientId,
    clientDomain: "studio.example",
    clientLogoUri: "https://images.example/studio.svg",
    picture,
    orgs: [],
    projects: [],
  });
  const org = await api.organizations.create({ name: "First organization" });
  using project = await api.projects.create({ project: "first-consent-project", orgId: org.id });
  const projectId = (await project.whoami()).projectId;
  const other = await api.organizations.create({ name: "Other organization" });
  using excluded = await api.projects.create({
    project: "unselected-consent-project",
    orgId: other.id,
  });
  const excludedId = (await excluded.whoami()).projectId;
  const view = await api.consent.describe(flow.url.search);
  expect(view).toMatchObject({
    kind: "consent",
    query: flow.url.search,
    email: user.email,
    // each requested scope with the page's copy (oauth-scopes.ts); `iterate` cannot be unticked
    scopes: [{ name: "iterate", required: true, note: "Required — what the app is for." }],
  });
  // the page lists a project by its slug; what a ticked box submits is its id
  if (view.kind !== "consent") throw new Error(`expected consent, got ${JSON.stringify(view)}`);
  expect(view.projects.map(({ id, slug }) => ({ id, slug }))).toEqual([
    { id: projectId, slug: "first-consent-project" },
    { id: excludedId, slug: "unselected-consent-project" },
  ]);
  expect((await api.organizations.list()).map((org) => org.name)).toEqual([
    "First organization",
    "Other organization",
  ]);
  expect(
    await api.consent.approve({ query: flow.url.search, projects: ["first-consent-project"] }),
  ).toEqual({ error: "Choose at least one project you can access." });
  const approval = await api.consent.approve({ query: flow.url.search, projects: [projectId] });
  if ("error" in approval) throw new Error(approval.error);
  const callback = new URL(approval.redirectTo);
  expect(callback.searchParams.get("state")).toBe(flow.state);
  expect(callback.searchParams.get("iss")).toBe(origin);
  const exchange = await SELF.fetch(`${origin}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      client_id: client.clientId,
      redirect_uri: "http://127.0.0.1:12345/callback",
      code_verifier: flow.verifier,
      resource: `${origin}/mcp`,
    }),
  });
  expect(exchange.status, await exchange.clone().text()).toBe(200);
  const tokens = await exchange.json<{ access_token: string }>();
  expect(tokens.access_token.split(":")[0]).toBe(user.id);
  // The one MCP tool is `run`. The grant reaches the CONSENTED project and no other, proven at the
  // tool: a run in `first-consent-project` succeeds (itx.whoami() names its id); a run in the
  // project the consent did NOT select is refused before it evaluates ("outside this token's grant").
  const runTool = (project: string) =>
    SELF.fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run", arguments: { project, script: "async (itx) => itx.whoami()" } },
      }),
    });
  const selected = await runTool(projectId);
  expect(selected.status).toBe(200);
  const selectedBody = await selected.text();
  expect(selectedBody).toContain(projectId);
  const unselectedBody = await (await runTool(excludedId)).text();
  expect(unselectedBody).toContain("outside this token");
  const grants = (await api.grants.list()).items;
  expect(grants).toHaveLength(2);
  expect(grants.find((grant) => grant.clientId === client.clientId)).toMatchObject({
    name: "Claude fixture",
    logoUri: "https://images.example/studio.svg",
    clientDomain: "studio.example",
  });
  await api.logout();
  // These calls land before the 30s live lease refresh: issuance reads the account's ended grants
  // on every admission (oauth.ts `authorizationOf`), so the logout denies at once.
  await expect(api.consent.approve({ query: flow.url.search, projects: ["*"] })).rejects.toThrow(
    /session has ended/,
  );
  await expect(api.grants.mint({ name: "Too late", projects: [projectId] })).rejects.toThrow(
    /session has ended/,
  );
  expect((await SELF.fetch(`${origin}/api`, { method: "POST", body: "", headers })).status).toBe(
    401,
  );
  expect(
    await appSession(bindings.BROWSER_SESSION, new Request(origin, { headers }))!.bearer(),
  ).toBeNull();
});

test("copied issuer client metadata and every scope confer app permissions but never consent authority", async () => {
  const user = await person("copied-client@example.com");
  const login = await startIssuerSession(bindings, new Request(origin), user, "/");
  const issuer = await connect({ Cookie: login.setCookie.split(";")[0]!, Origin: origin });
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: `${origin}/.auth/client.json`,
    redirectUri: `${origin}/.auth/callback`,
    resources: [`${origin}/api`],
    scopes: ["iterate", "account", "organizations:write"],
  });
  const approved = await issuer.consent.approve({ query: flow.url.search, projects: ["*"] });
  if ("error" in approved) throw new Error(approved.error);
  const callback = new URL(approved.redirectTo);
  const exchange = await SELF.fetch(`${origin}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      client_id: `${origin}/.auth/client.json`,
      redirect_uri: `${origin}/.auth/callback`,
      code_verifier: flow.verifier,
      resource: `${origin}/api`,
    }),
  });
  expect(exchange.status, await exchange.clone().text()).toBe(200);
  const token = await exchange.json<{ access_token: string }>();
  const app = await connect({ Authorization: `Bearer ${token.access_token}` });
  expect((await app.info()).scopes).toEqual(["iterate", "account", "organizations:write"]);
  expect((await app.grants.list()).items).toHaveLength(2);
  const org = await app.organizations.create({ name: "Clone organization" });
  expect((await app.organizations.list()).map((org) => org.id)).toContain(org.id);
  await expect(app.consent.describe(flow.url.search)).rejects.toThrow(/Sign in to iterate/);
  await expect(app.consent.approve({ query: flow.url.search, projects: ["*"] })).rejects.toThrow(
    /Sign in to iterate/,
  );
});

test("an issuer session minted before a scope existed still holds every scope — its list is not a consent", async () => {
  // the shape of startIssuerSession, with the two scopes an older cookie was minted with
  const user = await person("old-issuer-cookie@example.com");
  const { platformOrigin: issuerOrigin, api: apiResource } = platformAddressesOf(
    bindings,
    new Request("https://control.test/"),
  );
  const flow = await startAppSession(
    bindings.BROWSER_SESSION,
    {
      origin: issuerOrigin,
      issuer: issuerOrigin,
      resource: apiResource,
      scopes: ["iterate", "account"],
    },
    "/",
  );
  const request = await parseAuthorization(bindings, new Request(flow.location));
  const approved = await oauthHelpers(
    bindings,
    platformAddressesOf(bindings, new Request(`${origin}/`)),
  ).completeAuthorization({
    request,
    userId: user.id,
    scope: request.scope,
    metadata: { clientName: "iterate" },
    revokeExistingGrants: false,
    props: {
      kind: "issuer",
      version: 2,
      userId: user.id,
      email: user.email,
      projects: null,
      deadline: Date.now() + 30 * 24 * 3600_000,
    },
  });
  const result = await flow.session.complete(new URL(approved.redirectTo).search);
  expect(result.error).toBeUndefined();
  const old = await connect({ Cookie: flow.setCookie.split(";")[0]!, Origin: origin });
  expect((await old.info()).scopes).toEqual(["iterate", "account", "organizations:write"]);
  const org = await old.organizations.create({ name: "Made with an old cookie" });
  expect((await old.organizations.list()).map((candidate) => candidate.id)).toContain(org.id);
});

test("a browser landing on the platform origin is told it is headless and where the dash is", async () => {
  // rendered from the configuration (wrangler.test.jsonc), never a file's hostnames
  const page = await SELF.fetch(`${origin}/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await page.text();
  expect(html).toContain("<strong>control.test</strong> is deliberately headless");
  // the dash's CONNECT page, naming this issuer — a click there is what binds the browser to it
  expect(html).toContain(
    'href="https://dash.test/.auth/connect?issuer=https%3A%2F%2Fcontrol.test"',
  );
  expect(html).toContain('href="/login"');
});

test("the setup prompt an agent follows is served beside the pages, and the landing page points at it", async () => {
  const prompt = await SELF.fetch(`${origin}/setup-prompt.md`);
  expect(prompt.status).toBe(200);
  expect(prompt.headers.get("content-type")).toMatch(/^text\/(markdown|plain)/);
  const text = await prompt.text();
  expect(text).toContain("OS_NEXT_ENV=self-host pnpm --filter os build");
  expect(text).toContain("wrangler deploy --config apps/os/dist/server/wrangler.json");
  expect(text).toContain("/mcp");
  expect(text).toContain("dash.iterate.com/.auth/connect?issuer=");
  const page = await (await SELF.fetch(`${origin}/`)).text();
  expect(page).toContain('href="/setup-prompt.md"');
});

test("a client on a project's custom apex is bound to that project at consent, like one under the hostname base", async () => {
  const user = await person("custom-apex@example.com");
  const theirs = await operator(user.email);
  using apexProject = await theirs.projects.create({ project: "custom-apex-project" });
  using _other = await theirs.projects.create({ project: "custom-apex-other" });
  const apexProjectId = (await apexProject.whoami()).projectId;
  const login = await startIssuerSession(bindings, new Request(origin), user, "/");
  const issuer = await connect({ Cookie: login.setCookie.split(";")[0]!, Origin: origin });
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: "https://custom-apex.test/.auth/client.json",
    redirectUri: "https://custom-apex.test/.auth/callback",
    resources: [`${origin}/api`],
  });
  const view = await issuer.consent.describe(flow.url.search);
  if (view.kind !== "consent") throw new Error(`expected consent, got ${JSON.stringify(view)}`);
  expect(view.projectBound).toBe(true);
  // the apex map names the project by slug; the view's row carries the id a ticked box submits
  expect(view.projects.map(({ id, slug }) => ({ id, slug }))).toEqual([
    { id: apexProjectId, slug: "custom-apex-project" },
  ]);
});

test("consent grants only the scopes left ticked; organizations:write, not project reach, is what creates an organization", async () => {
  const user = await person("ticked-scopes@example.com");
  const login = await startIssuerSession(bindings, new Request(origin), user, "/");
  const issuer = await connect({ Cookie: login.setCookie.split(";")[0]!, Origin: origin });
  const org = await issuer.organizations.create({ name: "Ticked scopes organization" });
  using project = await issuer.projects.create({ project: "ticked-scopes-project", orgId: org.id });
  const projectId = (await project.whoami()).projectId;
  // the same request three scopes wide, approved for ONE project with the scopes given
  async function grant(scopes: string[]) {
    const flow = await authorizationCodeRequest({
      issuer: origin,
      clientId: `${origin}/.auth/client.json`,
      redirectUri: `${origin}/.auth/callback`,
      resources: [`${origin}/api`],
      scopes: ["iterate", "account", "organizations:write"],
    });
    const approved = await issuer.consent.approve({
      query: flow.url.search,
      projects: [projectId],
      scopes,
    });
    if ("error" in approved) throw new Error(approved.error);
    const callback = new URL(approved.redirectTo);
    const exchange = await SELF.fetch(`${origin}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        client_id: `${origin}/.auth/client.json`,
        redirect_uri: `${origin}/.auth/callback`,
        code_verifier: flow.verifier,
        resource: `${origin}/api`,
      }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const token = await exchange.json<{ access_token: string }>();
    return connect({ Authorization: `Bearer ${token.access_token}` });
  }
  // account and organizations:write unticked — and a scope the request never asked for is no scope
  const narrow = await grant(["iterate", "made-up"]);
  expect((await narrow.info()).scopes).toEqual(["iterate"]);
  await expect(narrow.organizations.create({ name: "Refused organization" })).rejects.toThrow(
    /organizations:write/,
  );
  await expect(narrow.grants.list()).rejects.toThrow(/Account permission/);
  // without the scope a project-narrowed grant sees only its projects' organizations
  expect((await narrow.organizations.list()).map((candidate) => candidate.id)).toEqual([org.id]);
  // every scope ticked: the grant is narrowed to one project and still creates an organization —
  // and, holding organizations:write, lists every organization of the person, the new one included
  const full = await grant(["iterate", "account", "organizations:write"]);
  expect((await full.info()).scopes).toEqual(["iterate", "account", "organizations:write"]);
  const created = await full.organizations.create({ name: "Created by a project-narrowed grant" });
  expect((await issuer.organizations.list()).map((candidate) => candidate.id)).toContain(
    created.id,
  );
  expect((await full.organizations.list()).map((candidate) => candidate.id)).toContain(created.id);
  // `organizations.get` is narrowed exactly as `list()` is: the project-bound grant without
  // organizations:write opens its project's organization and no other of the person's
  using narrowOwn = await narrow.organizations.get(org.id);
  expect((await narrowOwn.whoami()).path).toBe(`/organizations/${org.id}`);
  await expect(narrow.organizations.get(created.id)).rejects.toThrow(
    /not an organization this session belongs to/,
  );
  using fullOther = await full.organizations.get(created.id);
  expect((await fullOther.whoami()).path).toBe(`/organizations/${created.id}`);
  expect((await full.projects.list()).map(({ id, slug }) => ({ id, slug }))).toEqual([
    { id: projectId, slug: "ticked-scopes-project" },
  ]);
});

test("consent requires PKCE, defaults empty scopes, rejects empty reach and returns a cancellable request", async () => {
  const user = await person("consent-checks@example.com");
  const login = await startIssuerSession(bindings, new Request(origin), user, "/");
  const headers = { Cookie: login.setCookie.split(";")[0]!, Origin: origin };
  const api = await connect(headers);
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: `${origin}/.auth/client.json`,
    redirectUri: `${origin}/.auth/callback`,
    resources: [`${origin}/api`],
  });
  flow.url.searchParams.delete("scope");
  const view = await api.consent.describe(flow.url.search);
  expect(view.kind).toBe("consent");
  if (view.kind !== "consent") throw new Error("Expected consent");
  expect(view.scopes.map((scope) => scope.name)).toEqual(["iterate"]);
  expect(view.scopes[0]!.required).toBe(true);
  const cancel = new URL(view.denyLocation);
  expect(cancel.searchParams.get("error")).toBe("access_denied");
  expect(cancel.searchParams.get("state")).toBe(flow.state);
  expect(cancel.searchParams.get("iss")).toBe(origin);
  expect(await api.consent.approve({ query: flow.url.search, projects: [] })).toEqual({
    error: "Choose at least one project you can access.",
  });
  expect((await api.grants.list()).items).toHaveLength(1);
  flow.url.searchParams.delete("code_challenge");
  flow.url.searchParams.delete("code_challenge_method");
  const invalid = await api.consent.describe(flow.url.search);
  expect(invalid.kind).toBe("redirect");
  if (invalid.kind !== "redirect") throw new Error("Expected validated redirect");
  expect(new URL(invalid.location).searchParams.get("error_description")).toMatch(/must use PKCE/);
  // Without the issuer's session, the page and its Authorize form both send the browser to sign
  // in and back to this very request. The page is rendered on the server: there is no browser
  // bundle beside it and no JSON sibling (a non-page path on the platform origin is a 404).
  const signIn = `/login?${new URLSearchParams({ next: `/oauth2/auth${flow.url.search}` })}`;
  const page = await SELF.fetch(`${origin}/oauth2/auth${flow.url.search}`, { redirect: "manual" });
  expect(page.status).toBe(307);
  expect(page.headers.get("location")).toBe(signIn);
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  expect((await SELF.fetch(`${origin}/capnweb.js`)).status).toBe(404);
  const sibling = await SELF.fetch(`${origin}/authorize.json`, { redirect: "manual" });
  expect(sibling.status).toBe(404);
  const post = await SELF.fetch(`${origin}/oauth2/auth${flow.url.search}`, {
    method: "POST",
    headers: { Origin: origin },
    body: new FormData(),
    redirect: "manual",
  });
  expect(post.status).toBe(303);
  expect(post.headers.get("location")).toBe(signIn);
  // Force the client to refresh through the real public token endpoint.
  const session = appSession(bindings.BROWSER_SESSION, new Request(origin, { headers }))!;
  const before = await session.bearer();
  await runInDurableObject(session, async (_instance, state) => {
    const stored = await state.storage.get<Record<string, unknown>>("session");
    await state.storage.put("session", { ...stored, expiresAt: 0 });
  });
  const refreshed = await session.bearer();
  expect(refreshed).not.toBe(before);
  expect(await session.scopes()).toEqual(["iterate", "account", "organizations:write"]);
  expect(
    (await connect({ Authorization: `Bearer ${refreshed}` }).then((api) => api.info())).principal
      .actor,
  ).toBe(user.id);
});

test("consent omits missing, insecure and credential-bearing branding URLs", async () => {
  const user = await (await operator()).users.create({ email: "branding-urls@example.com" });
  const login = await startIssuerSession(bindings, new Request(origin), user, "/");
  const issuer = await connect({ Cookie: login.setCookie.split(";")[0]!, Origin: origin });
  for (const url of [
    undefined,
    "not a URL",
    "http://app.example/logo.svg",
    "data:image/svg+xml,<svg/>",
    "javascript:alert(1)",
    "https://user:password@app.example/logo.svg",
  ]) {
    const client = await oauthHelpers(
      bindings,
      platformAddressesOf(bindings, new Request(origin)),
    ).createClient({
      clientName: "Example App",
      clientUri: url,
      logoUri: url,
      redirectUris: ["https://app.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    const flow = await authorizationCodeRequest({
      issuer: origin,
      clientId: client.clientId,
      redirectUri: "https://app.example/callback",
      resources: [`${origin}/api`],
    });
    const view = await issuer.consent.describe(flow.url.search);
    expect(view.kind).toBe("consent");
    expect(view.kind === "consent" && view.clientLogoUri).toBeUndefined();
    expect(view.kind === "consent" && view.clientDomain).toBeUndefined();
  }
});

test("CIMD consent shows the metadata host even when the client declares a different website", async () => {
  const clientId = "https://metadata.example/oauth/client.json";
  vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (request.url === clientId)
      return Promise.resolve(
        Response.json({
          client_id: clientId,
          client_name: "Example App",
          client_uri: "https://different.example/",
          logo_uri: "https://images.example/app.svg",
          redirect_uris: ["https://app.example/callback"],
          token_endpoint_auth_method: "none",
        }),
      );
    return SELF.fetch(request);
  });
  const user = await (await operator()).users.create({ email: "branding-cimd@example.com" });
  const login = await startIssuerSession(bindings, new Request(origin), user, "/");
  const issuer = await connect({ Cookie: login.setCookie.split(";")[0]!, Origin: origin });
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId,
    redirectUri: "https://app.example/callback",
    resources: [`${origin}/api`],
  });
  expect(await issuer.consent.describe(flow.url.search)).toMatchObject({
    kind: "consent",
    clientDomain: "metadata.example",
    clientLogoUri: "https://images.example/app.svg",
  });
});

test("the consent page renders on the server, and Authorize posts the choice to the exact authorization URL", async () => {
  const user = await controlPlaneStub().createUser(
    { principal: null },
    {
      email: "consent-page@example.com",
    },
  );
  const project = await controlPlaneStub().createProject(
    { principal: { actor: user.id, email: user.email } },
    { project: `consent-page-${crypto.randomUUID().slice(0, 8)}` },
  );
  const login = await startIssuerSession(bindings, new Request(origin), user, "/");
  const cookie = login.setCookie.split(";")[0]!;
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: `${origin}/.auth/client.json`,
    redirectUri: `${origin}/.auth/callback`,
    resources: [`${origin}/api`, `${origin}/mcp`],
    scopes: ["iterate", "account"],
  });
  // Repeated resource keys and a `+` in the state: the router must not canonicalize the query.
  const state = `${flow.state} + OAuth state`;
  flow.url.searchParams.set("state", state);
  const page = await SELF.fetch(flow.url.href, { headers: { Cookie: cookie }, redirect: "manual" });
  expect(page.status, page.headers.get("location") ?? "").toBe(200);
  const html = await page.text();
  expect(html).toContain("wants to access your account");
  expect(html).toContain("consent-page@example.com");
  expect(html).toContain(project.slug);
  expect(html).toContain("See and end your sessions, and mint personal access tokens");
  // a form from another site acts on nobody's session
  const approval = new FormData();
  approval.append("project", project.id);
  approval.append("scope", "iterate");
  const crossSite = await SELF.fetch(flow.url.href, {
    method: "POST",
    headers: { Cookie: cookie, Origin: "https://evil.example" },
    body: approval,
    redirect: "manual",
  });
  expect(crossSite.status).toBe(403);
  const approved = await SELF.fetch(flow.url.href, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
    body: approval,
    redirect: "manual",
  });
  expect(approved.status).toBe(303);
  const callback = new URL(approved.headers.get("location")!);
  expect(callback.origin + callback.pathname).toBe(`${origin}/.auth/callback`);
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get("iss")).toBe(origin);
  expect(callback.searchParams.get("code")).toBeTruthy();
  // the grant is the posted choice: the one project, and `iterate` without the declined `account`
  const exchange = await SELF.fetch(`${origin}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      client_id: `${origin}/.auth/client.json`,
      redirect_uri: `${origin}/.auth/callback`,
      code_verifier: flow.verifier,
      resource: `${origin}/api`,
    }),
  });
  expect(exchange.status, await exchange.clone().text()).toBe(200);
  const token = await exchange.json<{ access_token: string }>();
  const app = await connect({ Authorization: `Bearer ${token.access_token}` });
  expect((await app.info()).scopes).toEqual(["iterate"]);
  expect((await app.projects.list()).map((listed) => listed.id)).toEqual([project.id]);
});
