import { env, SELF, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Env } from "../src/control-plane.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { directory } from "../src/directory.ts";
import { appSession } from "../src/client/app-auth.ts";
import { startIssuerSession } from "../src/issuer-session.ts";
import { oauthHelpers } from "../src/oauth.ts";
import { authorizationCodeRequest } from "../src/client/oauth.ts";
import { applyDirectorySchema } from "./support.ts";

const bindings = env as unknown as Env;
const origin = "https://control.test";
const sessions: Disposable[] = [];
beforeAll(applyDirectorySchema);
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

test("first consent creates organization and project through the ordinary session, then grants only the chosen project", async () => {
  const user = await directory(bindings.DB).upsertGoogleUser("1357924680", "bootstrap@example.com");
  const helpers = oauthHelpers(bindings);
  const client = await helpers.createClient({
    clientName: "Claude fixture",
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
  const login = await startIssuerSession(bindings, user, next);
  expect(login.location).toBe(next);
  expect(login.setCookie).toMatch(/^__Host-itx-session=[\da-f-]+; HttpOnly; Secure;/);
  const headers = { Cookie: login.setCookie.split(";")[0]!, Origin: origin };
  const api = await connect(headers);
  expect((await api.info()).principal).toEqual({ actor: user.id, email: user.email });
  expect(await api.orgs()).toEqual([]);
  expect(await api.projects.list()).toEqual([]);
  expect(await api.consent.describe(flow.url.search)).toMatchObject({
    kind: "consent",
    clientName: "Claude fixture",
    orgs: [],
    projects: [],
  });
  const org = await api.createOrg("First organization");
  using _project = await api.projects.create({ project: "first-consent-project", orgId: org.id });
  const other = await api.createOrg("Other organization");
  using _excluded = await api.projects.create({
    project: "unselected-consent-project",
    orgId: other.id,
  });
  const view = await api.consent.describe(flow.url.search);
  expect(view).toMatchObject({
    kind: "consent",
    query: flow.url.search,
    email: user.email,
    scopes: ["iterate"],
  });
  expect((await api.orgs()).map((org) => org.name)).toEqual([
    "First organization",
    "Other organization",
  ]);
  const approval = await api.consent.approve({
    query: flow.url.search,
    projects: ["first-consent-project"],
  });
  if ("error" in approval) throw new Error(approval.error);
  const callback = new URL(approval.redirectTo);
  expect(callback.searchParams.get("state")).toBe(flow.state);
  expect(callback.searchParams.get("iss")).toBe(origin);
  const exchange = await SELF.fetch(`${origin}/oauth/token`, {
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
  // tool: a run in `first-consent-project` succeeds (itx.whoami() names it); a run in the project the
  // consent did NOT select is refused before it evaluates ("outside this token's grant").
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
  const selected = await runTool("first-consent-project");
  expect(selected.status).toBe(200);
  const selectedBody = await selected.text();
  expect(selectedBody).toContain("first-consent-project");
  const unselectedBody = await (await runTool("unselected-consent-project")).text();
  expect(unselectedBody).toContain("outside this token");
  expect((await api.grants.list()).items).toHaveLength(2);
  await api.logout();
  // These calls land before the 30s live lease refresh: issuance still reads D1 now.
  await expect(api.consent.approve({ query: flow.url.search, projects: ["*"] })).rejects.toThrow(
    /session has ended/,
  );
  await expect(
    api.grants.mint({ name: "Too late", projects: ["first-consent-project"] }),
  ).rejects.toThrow(/session has ended/);
  expect((await SELF.fetch(`${origin}/api`, { method: "POST", body: "", headers })).status).toBe(
    401,
  );
  expect(
    await appSession(bindings.BROWSER_SESSION, new Request(origin, { headers }))!.bearer(),
  ).toBeNull();
});

test("copied issuer client metadata and account scope confer app permissions but never consent authority", async () => {
  const user = await directory(bindings.DB).upsertUser("copied-client@example.com");
  const login = await startIssuerSession(bindings, user, "/");
  const issuer = await connect({ Cookie: login.setCookie.split(";")[0]!, Origin: origin });
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: `${origin}/.auth/client.json`,
    redirectUri: `${origin}/.auth/callback`,
    resources: [`${origin}/api`],
    scopes: ["iterate", "account"],
  });
  const approved = await issuer.consent.approve({ query: flow.url.search, projects: ["*"] });
  if ("error" in approved) throw new Error(approved.error);
  const callback = new URL(approved.redirectTo);
  const exchange = await SELF.fetch(`${origin}/oauth/token`, {
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
  expect((await app.info()).scopes).toEqual(["iterate", "account"]);
  expect((await app.grants.list()).items).toHaveLength(2);
  const org = await app.createOrg("Clone organization");
  expect((await app.orgs()).map((org) => org.id)).toContain(org.id);
  await expect(app.consent.describe(flow.url.search)).rejects.toThrow(/Sign in to Iterate/);
  await expect(app.consent.approve({ query: flow.url.search, projects: ["*"] })).rejects.toThrow(
    /Sign in to Iterate/,
  );
});

test("consent requires PKCE, defaults empty scopes, rejects empty reach and returns a cancellable request", async () => {
  const user = await directory(bindings.DB).upsertUser("consent-checks@example.com");
  const login = await startIssuerSession(bindings, user, "/");
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
  expect(view.scopes).toEqual(["iterate"]);
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
  const page = await SELF.fetch(`${origin}/authorize`);
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  // Force the client to refresh through the real public token endpoint.
  const session = appSession(bindings.BROWSER_SESSION, new Request(origin, { headers }))!;
  const before = await session.bearer();
  await runInDurableObject(session, async (_instance, state) => {
    const stored = await state.storage.get<Record<string, unknown>>("session");
    await state.storage.put("session", { ...stored, expiresAt: 0 });
  });
  const refreshed = await session.bearer();
  expect(refreshed).not.toBe(before);
  expect(await session.scopes()).toEqual(["iterate", "account"]);
  expect(
    (await connect({ Authorization: `Bearer ${refreshed}` }).then((api) => api.info())).principal
      .actor,
  ).toBe(user.id);
});
