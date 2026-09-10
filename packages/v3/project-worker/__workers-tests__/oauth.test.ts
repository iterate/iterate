import { env, SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { directory } from "../src/directory.ts";
import { oauthHelpers } from "../src/oauth.ts";
import type { Env } from "../src/control-plane.ts";
import type { Session } from "../src/session.ts";
import definitions from "../src/control-plane.sql?raw";

const bindings = env as unknown as Env;
const ORIGIN = "https://control.test";
const adminSecret = bindings.APP_CONFIG_ADMIN_API_SECRET!;
const sessions: Disposable[] = [];
const call = (path: string, init?: RequestInit) =>
  SELF.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));
const helpers = () => oauthHelpers(bindings, new Request(ORIGIN));

beforeAll(async () => {
  await bindings.DB.batch(
    definitions
      .replace(/--.*$/gm, "")
      .split(";")
      .map((sql) => sql.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((sql) => bindings.DB.prepare(sql)),
  );
});
afterEach(() => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]();
});

async function rpc(token: string) {
  const response = await call("/api", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`, Origin: ORIGIN },
  });
  expect(response.status, await (response.status === 101 ? "" : response.text())).toBe(101);
  response.webSocket!.accept();
  const root = newWebSocketRpcSession<Session>(response.webSocket! as unknown as WebSocket);
  sessions.push(root);
  return { root };
}

async function tool(token: string, name: string, args: object = {}) {
  const response = await call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body:
      response.status !== 200
        ? null
        : response.headers.get("content-type")?.startsWith("text/event-stream")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)))
              .find((message) => message.id === 1)
          : JSON.parse(text),
  };
}

/** Local HTTPS client metadata is not public. Only registration is a fixture;
 * consent, PKCE, exchange, refresh and resource admission all use the real server. */
async function grant(resources: string[], projects: string[] = ["oauth-a"]) {
  const login = await call("/login", {
    method: "POST",
    body: new URLSearchParams({ email: "oauth-new@example.com", next: "/" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const user = await directory(bindings.DB).upsertUser("oauth-new@example.com");
  await directory(bindings.DB).createProject({ userId: user.id }, "oauth-a");
  await directory(bindings.DB).createProject({ userId: user.id }, "oauth-b");
  const client = await helpers().createClient({
    clientName: "OAuth integration",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const verifier =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: "https://client.test/callback",
    scope: "iterate",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  for (const resource of resources) query.append("resource", resource);
  const approval = await call(`/authorize?${query}`, {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams(projects.map((project) => ["project", project])),
  });
  expect(approval.status, await approval.clone().text()).toBe(302);
  const redirect = new URL(approval.headers.get("location")!);
  const code = redirect.searchParams.get("code");
  if (!code)
    return { error: redirect.searchParams.get("error"), cookie, clientId: client.clientId, user };
  const tokenResponse = await call("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.clientId,
      redirect_uri: "https://client.test/callback",
      code_verifier: verifier,
    }),
  });
  const token = await tokenResponse.json<{ access_token: string; refresh_token: string }>();
  expect(tokenResponse.status, JSON.stringify(token)).toBe(200);
  return { token, cookie, clientId: client.clientId, user };
}

test("discovery advertises CIMD and neither publishes nor serves DCR", async () => {
  const metadata = await (
    await call("/.well-known/oauth-authorization-server")
  ).json<Record<string, unknown>>();
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  expect(metadata.registration_endpoint).toBeUndefined();
  expect((await call("/oauth/register", { method: "POST" })).status).toBe(404);
  for (const protocol of ["api", "mcp"]) {
    expect(
      await (await call(`/.well-known/oauth-protected-resource/${protocol}`)).json(),
    ).toMatchObject({
      resource: `${ORIGIN}/${protocol}`,
      authorization_servers: [ORIGIN],
      scopes_supported: ["iterate"],
    });
    expect((await call(`/${protocol}`)).status).toBe(401);
  }
});

test("the configured header bearer is the same administrator at both protocols", async () => {
  const { root } = await rpc(adminSecret);
  expect(await root.whoami()).toEqual({ actor: "admin" });
  expect(JSON.parse((await tool(adminSecret, "whoami")).body.result.content[0].text)).toEqual({
    actor: "admin",
  });
  expect((await call("/api", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await tool("wrong", "whoami")).status).toBe(401);
});

test("one provider grant can cover MCP and Cap'n Web while retaining membership and its project ceiling", async () => {
  const flow = await grant([`${ORIGIN}/api`, `${ORIGIN}/mcp`]);
  expect(flow.token).toBeDefined();
  const token = flow.token!.access_token;
  const { root } = await rpc(token);
  expect(await root.whoami()).toEqual({ actor: flow.user.id, email: flow.user.email });
  expect((await root.projects.list()).map((p: { id: string }) => p.id)).toEqual(["oauth-a"]);
  await expect(root.projects.get("oauth-b")).rejects.toThrow(/outside/);
  const context = root.projects.get("oauth-a");
  await expect(context.mintToken()).rejects.toThrow(/FORBIDDEN|delegation|token/i);
  expect((await tool(token, "whoami")).status).toBe(200);
  const org = (await directory(bindings.DB).getProject("oauth-a"))!.orgId;
  await bindings.DB.prepare("DELETE FROM org_members WHERE user_id = ? AND org_id = ?")
    .bind(flow.user.id, org)
    .run();
  expect(await root.projects.list()).toEqual([]);
  expect(
    (await tool(token, "itx.invoke", { project: "oauth-a", expression: "itx.kv.get('x')" })).body
      .result.isError,
  ).toBe(true);
  await bindings.DB.prepare("INSERT INTO org_members (user_id, org_id) VALUES (?, ?)")
    .bind(flow.user.id, org)
    .run();
});

test("resource narrowing, refresh and the revocation marker use the provider lifecycle", async () => {
  const flow = await grant([`${ORIGIN}/mcp`]);
  const token = flow.token!;
  expect(
    (await call("/api", { headers: { Authorization: `Bearer ${token.access_token}` } })).status,
  ).toBe(401);
  const broaden = await call("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: flow.clientId,
      resource: `${ORIGIN}/api`,
    }),
  });
  expect(broaden.status).toBe(400);
  const refresh = await call("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: flow.clientId,
    }),
  });
  expect(refresh.status, await refresh.clone().text()).toBe(200);
  const renewed = await refresh.json<{ access_token: string; refresh_token: string }>();
  const [userId, grantId] = renewed.access_token.split(":");
  // Deliberately retain all valid KV records to prove D1 denial despite KV propagation.
  await bindings.DB.prepare(
    "INSERT INTO oauth_activity (user_id, grant_id, revoked_at) VALUES (?, ?, ?) ON CONFLICT(user_id, grant_id) DO UPDATE SET revoked_at = excluded.revoked_at",
  )
    .bind(userId, grantId, Date.now())
    .run();
  expect((await tool(renewed.access_token, "whoami")).status).toBe(401);
  expect(
    (
      await call("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: renewed.refresh_token,
          client_id: flow.clientId,
        }),
      })
    ).status,
  ).toBe(400);
});

test("an issuer cookie alone cannot authorize API calls or the operator RPC door", async () => {
  const flow = await grant([`${ORIGIN}/api`]);
  expect((await call("/api", { headers: { cookie: flow.cookie, Origin: ORIGIN } })).status).toBe(
    401,
  );
});

test("console and project browsers use the same CIMD flow and independent grants", async () => {
  const metadataFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/.auth/client.json") throw new Error(`Unexpected external fetch: ${url}`);
    return SELF.fetch(url.href);
  });
  const issuerLogin = await call("/login", {
    method: "POST",
    body: new URLSearchParams({ email: "browser@example.com", next: "/" }),
  });
  const issuerCookie = issuerLogin.headers.get("set-cookie")!.split(";")[0]!;
  const user = await directory(bindings.DB).upsertUser("browser@example.com");
  await directory(bindings.DB).createProject({ userId: user.id }, "browser-a");
  await directory(bindings.DB).createProject({ userId: user.id }, "browser-b");
  const logins = [];
  try {
    for (const origin of [ORIGIN, "https://notes--browser-a.projects.test"]) {
      const metadata = await SELF.fetch(`${origin}/.auth/client.json`);
      expect(metadata.status).toBe(200);
      const start = await SELF.fetch(`${origin}/.auth/login?next=/`, { redirect: "manual" });
      const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
      const authorize = new URL(start.headers.get("location")!);
      expect(authorize.origin).toBe(ORIGIN);
      expect(authorize.searchParams.get("client_id")).toBe(`${origin}/.auth/client.json`);
      const approve = await SELF.fetch(authorize.href, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: issuerCookie, Origin: ORIGIN },
        body: new URLSearchParams([
          ["project", "*"],
          ["project", "browser-a"],
          ["project", "browser-b"],
        ]),
      });
      expect(approve.status, await approve.clone().text()).toBe(302);
      const callback = await SELF.fetch(approve.headers.get("location")!, {
        redirect: "manual",
        headers: { cookie },
      });
      expect(callback.status, await callback.clone().text()).toBe(303);
      const response = await SELF.fetch(`${origin}/api`, {
        headers: { cookie, Origin: origin, Upgrade: "websocket" },
      });
      expect(response.status, response.status === 101 ? "" : await response.text()).toBe(101);
      response.webSocket!.accept();
      const root = newWebSocketRpcSession<Session>(response.webSocket! as unknown as WebSocket);
      sessions.push(root);
      expect(await root.whoami()).toEqual({ actor: user.id, email: user.email });
      expect((await root.projects.list()).map((p: { id: string }) => p.id).sort()).toEqual(
        origin === ORIGIN ? ["browser-a", "browser-b"] : ["browser-a"],
      );
      expect(
        (await SELF.fetch(`${origin}/api`, { headers: { cookie, Origin: "https://evil.test" } }))
          .status,
      ).toBe(403);
      logins.push({ origin, cookie });
    }
    expect((await helpers().listUserGrants(user.id)).items).toHaveLength(2);
    const consoleLogin = logins[0]!;
    expect(
      (
        await call("/.auth/logout", {
          method: "POST",
          headers: { cookie: consoleLogin.cookie, Origin: ORIGIN },
        })
      ).status,
    ).toBe(303);
    expect(
      (await call("/api", { headers: { cookie: consoleLogin.cookie, Origin: ORIGIN } })).status,
    ).toBe(401);
    const app = logins[1]!;
    expect(
      (
        await SELF.fetch(`${app.origin}/api`, {
          headers: { cookie: app.cookie, Origin: app.origin, Upgrade: "websocket" },
        })
      ).status,
    ).toBe(101);
  } finally {
    metadataFetch.mockRestore();
  }
});
