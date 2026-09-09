// __workers-tests__/control-plane.test.ts — SIGN-IN, end to end, in the one local lane that binds a
// D1: the control plane's doors (src/control-plane) and the session they yield over /api
// (src/session.ts — the apps/os shape: `authenticate()` → `projects.list/get/create`).
//   EMAIL login mode: the login form → the session cookie → a browser's same-origin socket to /api
//   carries it → `authenticate()` knows who you are → `projects.create({ slug })` vends the project's
//   root context, `list()` catalogs it, `get(id)` admits members only; a taken name is refused,
//   coded; no cookie ⇒ UNAUTHENTICATED; the console lists and (by its form) creates; the post-login
//   redirect stays on the origin; /mcp wants an OAuth bearer.
//   OPEN login mode (this lane's own configuration): every visitor is the anonymous user — no
//   principal, every project's door open, a /login cookie cannot make a second identity — and /mcp
//   is tokenless.
// The worker's default fetch is called directly so each mode gets its own env (app-config.ts
// memoizes the configuration per env object).

import { createExecutionContext, env } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import definitionsSql from "../src/control-plane/definitions.sql?raw";
import { signClaims } from "../src/principal.ts";
import worker from "../src/worker.ts";

const openMode = env as unknown as Record<string, unknown>;
const emailMode = { ...openMode, APP_CONFIG_LOGIN_MODE: "email" };

/** One request to the worker's front door under `mode`'s configuration. */
const call = (mode: Record<string, unknown>, path: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(
    new Request(`https://control.test${path}`, init),
    mode as never,
    createExecutionContext(),
  );

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  body: new URLSearchParams(fields),
});

/** Sign in as `email` through the console's form: the session cookie (`name=value`). */
async function signIn(mode: Record<string, unknown>, email: string): Promise<string> {
  const login = await call(mode, "/login", form({ email, next: "/" }));
  return (login.headers.get("set-cookie") ?? "").split(";")[0];
}

// capnweb sessions over /api, opened on the worker's own 101 (the socket pair lives in this isolate);
// disposed at teardown so nothing lingers into the lane's teardown.
const sessions: unknown[] = [];
/** The `UnauthenticatedSession` stub a client holds after dialing /api — with the cookie a browser
 *  would carry, or without. */
async function api(mode: Record<string, unknown>, cookie?: string): Promise<any> {
  const res = await call(mode, "/api", {
    headers: { Upgrade: "websocket", ...(cookie && { cookie }) },
  });
  if (!res.webSocket) throw new Error(`expected a 101 with a WebSocket, got ${res.status}`);
  res.webSocket.accept();
  const session = newWebSocketRpcSession(res.webSocket as unknown as WebSocket);
  sessions.push(session);
  return session as any;
}
afterAll(() => {
  for (const session of sessions) {
    try {
      (session as Partial<Disposable>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
  }
});

/** The code of a call that MUST reject. */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

/** The JSON-RPC result of an /mcp answer — a JSON body, or (a tool call) one SSE `data:` frame. */
async function mcpResult(response: Response): Promise<{ content: { text: string }[] }> {
  const text = await response.text();
  const data = text.startsWith("event:")
    ? (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice("data:".length)
    : text;
  return (JSON.parse(data) as { result: { content: { text: string }[] } }).result;
}

/** A JSON-RPC call on /mcp. */
async function mcp(
  mode: Record<string, unknown>,
  method: string,
  params: unknown,
  sessionId?: string | null,
): Promise<Response> {
  return call(mode, "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId && { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

beforeAll(async () => {
  // THE DIRECTORY SCHEMA into this lane's (empty) D1 — the same split-and-batch the e2e global-setup does.
  const db = openMode.DB as D1Database;
  const statements = definitionsSql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  await db.batch(statements.map((statement) => db.prepare(statement)));
});

test("email mode: sign in on the console, then the cookie's socket to /api authenticates — projects.create vends the root context, list catalogs it, get admits members only, a taken name is coded", async () => {
  const anonymousHome = await call(emailMode, "/");
  expect(anonymousHome.status).toBe(200);
  expect(await anonymousHome.text()).toContain("Sign in");

  // the login form: the post-login redirect never leaves the origin
  const login = await call(
    emailMode,
    "/login",
    form({ email: "Ada@Example.com", next: "//evil.example/x" }),
  );
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/");
  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^itx-control-plane-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly/);
  const ada = setCookie.split(";")[0];

  // THE SESSION SHAPE: a socket carrying the cookie → authenticate() knows who you are
  const session = (await api(emailMode, ada)).authenticate();
  expect(await session.whoami()).toEqual({
    actor: "user_ada@example.com",
    email: "ada@example.com",
  });
  const created = await session.projects.create({ slug: "My Project" });
  expect(await created.whoami()).toEqual({ projectId: "my-project", path: "/" }); // the id IS the slugified name
  expect(await session.projects.list()).toEqual([
    { id: "my-project", orgId: expect.stringMatching(/^org_/), role: "owner" },
  ]);
  expect(await session.projects.get("my-project").whoami()).toEqual({
    projectId: "my-project",
    path: "/",
  });
  // …and its events carry her — the DO's own stamp
  const [note] = await created.append({ type: "note", payload: { n: 1 } });
  expect(note.source?.principal).toEqual({
    actor: "user_ada@example.com",
    email: "ada@example.com",
  });
  // the same user again: idempotent
  expect(await (await session.projects.create({ slug: "my-project" })).whoami()).toMatchObject({
    projectId: "my-project",
  });

  // another user: cannot take the name, cannot reach her project, sees only their own
  const bob = (await api(emailMode, await signIn(emailMode, "bob@example.com"))).authenticate();
  expect(await codeOf(bob.projects.create({ slug: "my-project" }))).toBe("PROJECT_NAME_TAKEN");
  expect(await codeOf(bob.projects.get("my-project").whoami())).toBe("FORBIDDEN");
  await bob.projects.create({ slug: "bobs" });
  expect((await bob.projects.list()).map((p: { id: string }) => p.id)).toEqual(["bobs"]);

  // no cookie: no identity, no session
  expect(await codeOf((await api(emailMode)).authenticate().whoami())).toBe("UNAUTHENTICATED");

  // the console: lists her project, and its form creates one
  expect(await (await call(emailMode, "/", { headers: { cookie: ada } })).text()).toContain(
    "<code>my-project</code>",
  );
  const viaForm = await call(emailMode, "/projects", {
    ...form({ slug: "Form Project" }),
    headers: { cookie: ada },
  });
  expect(viaForm.status).toBe(302);
  expect((await session.projects.list()).map((p: { id: string }) => p.id)).toEqual([
    "form-project",
    "my-project",
  ]);
  expect((await call(emailMode, "/projects", form({ slug: "nope" }))).status).toBe(302); // no cookie: back to sign in
  // /mcp is the OAuth-protected boundary: without a bearer the provider refuses
  expect((await mcp(emailMode, "initialize", {})).status).toBe(401);
  // logout clears the cookie
  expect(
    (await call(emailMode, "/logout", { method: "POST" })).headers.get("set-cookie"),
  ).toContain("Max-Age=0");
});

test("open mode (this lane's configuration): every visitor is the anonymous user — no principal, projects.create/list work, every project's door is open, a /login cookie cannot make a second identity, /mcp is tokenless", async () => {
  const session = (await api(openMode)).authenticate();
  expect(await session.whoami()).toBeNull(); // attribution, and there is none
  expect(await (await session.projects.create({ slug: "open-project" })).whoami()).toEqual({
    projectId: "open-project",
    path: "/",
  });
  expect((await session.projects.list()).map((p: { id: string }) => p.id)).toContain(
    "open-project",
  );
  expect(await session.projects.get("never-created").whoami()).toEqual({
    projectId: "never-created",
    path: "/",
  }); // the open door: the trusted-client doctrine every local proof relies on

  expect(await (await call(openMode, "/")).text()).toContain("<code>open-project</code>");
  const cookie = await signIn(openMode, "mallory@example.com");
  expect(await (await call(openMode, "/", { headers: { cookie } })).text()).toContain(
    "Signed in as anonymous",
  );
  expect(await (await api(openMode, cookie)).authenticate().whoami()).toBeNull();

  const initialized = await mcp(openMode, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "control-plane.test", version: "0" },
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id");
  const whoami = await mcp(openMode, "tools/call", { name: "whoami", arguments: {} }, sessionId);
  expect(whoami.status).toBe(200);
  expect(JSON.parse((await mcpResult(whoami)).content[0].text)).toEqual({
    email: "anonymous",
    sub: "user_anonymous",
  });
  const listed = await mcp(
    openMode,
    "tools/call",
    { name: "list_projects", arguments: {} },
    sessionId,
  );
  expect((await mcpResult(listed)).content[0].text).toContain("open-project");
});

test("the fetch lane (/expression): in email mode a non-member is 401 (a member's cookie or the project's bearer admits), and a visitor's `x-itx-*` headers never reach the DO's internal protocol", async () => {
  const lane = (await api(openMode)).authenticate();
  const target = await lane.projects.create({ slug: "lane-project" });
  // a forged pager header (the DO's internal attach protocol, which appends the events it carries)
  // is stripped at the edge: nothing lands in the log
  const forged = encodeURIComponent(
    JSON.stringify({
      rpcStubKey: "attack",
      appendEvents: [{ type: "events.iterate.com/stream/paused", payload: { reason: "forged" } }],
    }),
  );
  await call(openMode, "/expression?context=lane-project&itx=itx.whoami()", {
    headers: { "x-itx-rpc-stub-pager": forged, Upgrade: "websocket" },
  });
  const events = (await target.readEvents(0, 100)).events as { type: string }[];
  expect(events.some((e) => e.type === "events.iterate.com/stream/paused")).toBe(false);
  // email mode: a member's cookie (or a project-token bearer) admits; anyone else is 401
  const ada = await signIn(emailMode, "lane-ada@example.com");
  await (await api(emailMode, ada)).authenticate().projects.create({ slug: "adas-lane" });
  const bob = await signIn(emailMode, "lane-bob@example.com");
  expect(
    (
      await call(emailMode, "/expression?context=adas-lane&itx=itx.whoami()", {
        headers: { cookie: bob },
      })
    ).status,
  ).toBe(401);
  expect((await call(emailMode, "/expression?context=adas-lane&itx=itx.whoami()")).status).toBe(
    401,
  );
  expect(
    (
      await call(emailMode, "/expression?context=adas-lane&itx=itx.whoami()", {
        headers: { cookie: ada },
      })
    ).status,
  ).not.toBe(401); // admitted — what the lane answers for a non-fetch-shaped target is its own business
});

// THE MACHINE LANE ON A PROJECT HOST in email mode: `itx.serveMcp()` mounted as `itx.apps.mcp`,
// reached as `mcp--<p>.<base>` — the project-host spelling of the fetch lane (worker.ts), with the
// lane's directory admission and the DO dialled inside this lane. Mounted once, for the control and
// the pin.
const emailHostMode = {
  ...emailMode,
  APP_CONFIG_PROJECT_HOSTNAME_BASE: "projects.test",
  APP_CONFIG_PROJECT_TOKEN_SECRET: "mcp-host-secret",
};
let mcpLaneMounted: Promise<void> | undefined;
/** `tools/call itx.invoke("itx.builtins.secrets.list()")` on the mounted MCP host, under `headers`. */
async function mcpLaneToolsCall(headers: Record<string, string>): Promise<Response> {
  await (mcpLaneMounted ??= (async () => {
    const ada = await signIn(emailHostMode, "mcp-ada@example.com");
    const itx = await (
      await api(emailHostMode, ada)
    )
      .authenticate()
      .projects.create({ slug: "mcp-lane" });
    await itx.provide("itx.apps.mcp", "itx.serveMcp()");
  })());
  return worker.fetch(
    new Request("https://mcp--mcp-lane.projects.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "itx.invoke", arguments: { expression: "itx.builtins.secrets.list()" } },
      }),
    }),
    emailHostMode as never,
    createExecutionContext(),
  );
}

test("email mode: mcp--<p>.<base> serves a tools/call bearing the project's token (the control for the pin below)", async () => {
  const token = await signClaims(
    { projectId: "mcp-lane", actor: "user_mcp-ada@example.com", expiresAt: Date.now() + 60_000 },
    "mcp-host-secret",
  );
  const withBearer = await mcpLaneToolsCall({ authorization: `Bearer ${token}` });
  expect(withBearer.status, await withBearer.text()).toBe(200);
});

// PINNED RED — a design call the owner makes, not fixed here. The project host admits everyone by
// design (a site is public), and `itx.serveMcp()` mounted as an app hands `itx.invoke` to whoever
// reaches the host: an anonymous tools/call reaches every platform root and `itx.builtins.*`, which
// no rule can mask — in `email` login mode the WHOLE context, while the `/expression` spelling of the
// same lane admits members only (the fetch-lane test above). The library cannot see the login mode
// (it is written against `itx` alone), so the refusal belongs either to the ingress (a per-app
// admission the host does not have) or to the handle reading its Request's principal stamp under a
// mode it is told.
test.fails("email mode: mcp--<p>.<base> refuses a tools/call carrying no principal", async () => {
  const anonymous = await mcpLaneToolsCall({});
  expect(anonymous.status, await anonymous.text()).toBe(401);
});
