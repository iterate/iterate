import { env, SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeAll, expect, test } from "vitest";
import type { Env } from "../src/control-plane.ts";
import type { UnauthenticatedSession } from "../src/session.ts";
import { applyDirectorySchema, SRC_ECHO_APP } from "./support.ts";

const origin = "https://control.test";
const secret = (env as unknown as Env).APP_CONFIG_ADMIN_API_SECRET!;
const sessions: Disposable[] = [];
beforeAll(applyDirectorySchema);
afterEach(() => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]();
});

async function operator(email?: string) {
  const response = await SELF.fetch(`${origin}/internal/rpc`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  const root = newWebSocketRpcSession<UnauthenticatedSession>(
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

test("operator RPC accepts only its administrator credential; issuer cookies grant no API access", async () => {
  const login = await SELF.fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${secret}` },
    body: new URLSearchParams({ email: "fixture@directory.test", next: "https://elsewhere.test" }),
  });
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/");
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect((await SELF.fetch(`${origin}/api`, { headers: { cookie, Origin: origin } })).status).toBe(
    401,
  );
  const response = await SELF.fetch(`${origin}/internal/rpc`, {
    headers: { Upgrade: "websocket", cookie },
  });
  response.webSocket!.accept();
  using api = newWebSocketRpcSession<UnauthenticatedSession>(
    response.webSocket! as unknown as WebSocket,
  );
  await expect(api.authenticate({ type: "from-server-cookie" })).rejects.toThrow(/admin secret/);
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
