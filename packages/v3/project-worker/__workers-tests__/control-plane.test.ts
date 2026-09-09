// __workers-tests__/control-plane.test.ts — SIGN-IN, end to end, in the one local lane that binds a
// D1: the control plane's doors (src/control-plane.ts) and the session they yield over /api
// (src/session.ts — the apps/os shape: `authenticate(credentials)` → `projects.list/get/create`).
//   THE COOKIE: the login form → the session cookie → a browser's same-origin socket to /api carries
//   it → `authenticate({ type: "from-server-cookie" })` knows who you are (a foreign Origin, and no
//   cookie at all, are UNAUTHENTICATED) → `projects.create({ project })` vends the project's root
//   context, `list()` catalogs it, `get(project)` admits members only; a taken name is refused,
//   coded; the console lists and (by its form) creates; the post-login redirect stays on the origin;
//   /mcp wants an OAuth bearer.
//   THE ADMIN SECRET (this lane's configured one, wrangler.test.jsonc): `{ actor: "admin" }` on a
//   project the admin is no member of, every project listed, a project of its own in `org_admin`;
//   `as` is a user's session confined to their orgs; a wrong secret is INVALID_CREDENTIALS.
//   THE FETCH LANE: a member's cookie, the project's bearer or the admin bearer admits; anyone else
//   is 401; a visitor's `x-itx-*` headers never reach the DO's internal protocol.
// The worker's default fetch is called directly so a test can hand it its own env (worker.ts's app
// config memoizes the configuration per env object).

import { createExecutionContext, env } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import definitionsSql from "../src/control-plane.sql?raw";
import { signClaims } from "../src/principal.ts";
import worker from "../src/worker.ts";

const workersLaneEnv = env as unknown as Record<string, unknown>;
/** This lane's admin secret (wrangler.test.jsonc). */
const ADMIN_API_SECRET = String(workersLaneEnv.APP_CONFIG_ADMIN_API_SECRET);
const ADMIN = { type: "admin-secret", secret: ADMIN_API_SECRET } as const;
const COOKIE = { type: "from-server-cookie" } as const;
const ORIGIN = "https://control.test";

/** One request to the worker's front door under `mode`'s configuration. */
const call = (mode: Record<string, unknown>, path: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), mode as never, createExecutionContext());

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
/** The `UnauthenticatedSession` stub a client holds after dialing /api — with the headers the
 *  handshake carried: a browser's `cookie` and `origin`, or nothing (a script's socket). */
async function api(
  mode: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<any> {
  const res = await call(mode, "/api", { headers: { Upgrade: "websocket", ...headers } });
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

/** A JSON-RPC call on /mcp. */
async function mcp(
  mode: Record<string, unknown>,
  method: string,
  params: unknown,
): Promise<Response> {
  return call(mode, "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

beforeAll(async () => {
  // THE DIRECTORY SCHEMA into this lane's (empty) D1 — the same split-and-batch the e2e global-setup does.
  const db = workersLaneEnv.DB as D1Database;
  const statements = definitionsSql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  await db.batch(statements.map((statement) => db.prepare(statement)));
});

test("the cookie: sign in on the console, then the cookie's same-origin socket to /api authenticates — projects.create vends the root context, list catalogs it, get admits members only, a taken name is coded; a foreign Origin and no cookie are UNAUTHENTICATED", async () => {
  const anonymousHome = await call(workersLaneEnv, "/");
  expect(anonymousHome.status).toBe(200);
  expect(await anonymousHome.text()).toContain("Sign in");

  // the login form: the post-login redirect never leaves the origin
  const login = await call(
    workersLaneEnv,
    "/login",
    form({ email: "Ada@Example.com", next: "//evil.example/x" }),
  );
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/");
  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^itx-control-plane-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly/);
  const ada = setCookie.split(";")[0];

  // THE SESSION SHAPE: a same-origin browser socket carrying the cookie → the named credential
  // knows who you are
  const session = (await api(workersLaneEnv, { cookie: ada, origin: ORIGIN })).authenticate(COOKIE);
  expect(await session.whoami()).toEqual({
    actor: "user_ada@example.com",
    email: "ada@example.com",
  });
  const created = await session.projects.create({ project: "My Project" });
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
  expect(await (await session.projects.create({ project: "my-project" })).whoami()).toMatchObject({
    projectId: "my-project",
  });

  // another user, on a socket with no Origin (a script's): cannot take the name, cannot reach her
  // project, sees only their own
  const bob = (
    await api(workersLaneEnv, { cookie: await signIn(workersLaneEnv, "bob@example.com") })
  ).authenticate(COOKIE);
  expect(await codeOf(bob.projects.create({ project: "my-project" }))).toBe("PROJECT_NAME_TAKEN");
  expect(await codeOf(bob.projects.get("my-project").whoami())).toBe("FORBIDDEN");
  await bob.projects.create({ project: "bobs" });
  expect((await bob.projects.list()).map((p: { id: string }) => p.id)).toEqual(["bobs"]);

  // the cookie counts on a same-origin request only: a foreign site's socket carries it too, and
  // is refused — cross-site request forgery over RPC is the one hole the named credential closes
  const foreign = (await api(workersLaneEnv, { cookie: ada, origin: "https://evil.example" }))
    .authenticate(COOKIE)
    .whoami();
  expect(await codeOf(foreign)).toBe("UNAUTHENTICATED");
  // no cookie: no identity, no session
  expect(await codeOf((await api(workersLaneEnv)).authenticate(COOKIE).whoami())).toBe(
    "UNAUTHENTICATED",
  );

  // the console: lists her project, and its form creates one
  expect(await (await call(workersLaneEnv, "/", { headers: { cookie: ada } })).text()).toContain(
    "<code>my-project</code>",
  );
  const viaForm = await call(workersLaneEnv, "/projects", {
    ...form({ slug: "Form Project" }),
    headers: { cookie: ada },
  });
  expect(viaForm.status).toBe(302);
  expect((await session.projects.list()).map((p: { id: string }) => p.id)).toEqual([
    "form-project",
    "my-project",
  ]);
  expect((await call(workersLaneEnv, "/projects", form({ slug: "nope" }))).status).toBe(302); // no cookie: back to sign in
  // /mcp is the OAuth-protected boundary: without a bearer the provider refuses
  expect((await mcp(workersLaneEnv, "initialize", {})).status).toBe(401);
  // logout clears the cookie
  expect(
    (await call(workersLaneEnv, "/logout", { method: "POST" })).headers.get("set-cookie"),
  ).toContain("Max-Age=0");
});

test("the admin secret: { actor: 'admin' } reaches a project the admin is no member of, lists every project, creates in org_admin; `as` is a user's session confined to their orgs; a wrong secret is INVALID_CREDENTIALS, the project-secret kind UNSUPPORTED_CREDENTIAL", async () => {
  // a user's project, made the ordinary way
  const dana = await signIn(workersLaneEnv, "dana@example.com");
  await (await api(workersLaneEnv, { cookie: dana })).authenticate(COOKIE).projects.create({
    project: "danas",
  });

  const admin = (await api(workersLaneEnv)).authenticate(ADMIN);
  expect(await admin.whoami()).toEqual({ actor: "admin" });
  expect(await admin.projects.get("danas").whoami()).toEqual({ projectId: "danas", path: "/" }); // no membership needed
  expect(await admin.projects.get("never-created").whoami()).toEqual({
    projectId: "never-created",
    path: "/",
  }); // any project: the door is the admin's
  expect(await (await admin.projects.create({ project: "admin-project" })).whoami()).toEqual({
    projectId: "admin-project",
    path: "/",
  });
  const all = (await admin.projects.list()) as { id: string; orgId: string; role?: string }[];
  expect(all.map((p) => p.id)).toEqual(expect.arrayContaining(["admin-project", "danas"]));
  expect(all.find((p) => p.id === "admin-project")).toEqual({
    id: "admin-project",
    orgId: "org_admin",
  });
  // …and the admin's events say so
  const [note] = await admin.projects
    .get("danas")
    .append({ type: "note", payload: { by: "admin" } });
  expect(note.source?.principal).toEqual({ actor: "admin" });

  // `as`: carol never signed in — her row is upserted, her session is hers alone (the projects of
  // her orgs, a project created in her own org), exactly as the cookie would have made it
  const carol = (await api(workersLaneEnv)).authenticate({
    ...ADMIN,
    as: { sub: "user_carol@example.com", email: "carol@example.com" },
  });
  expect(await carol.whoami()).toEqual({
    actor: "user_carol@example.com",
    email: "carol@example.com",
  });
  expect(await codeOf(carol.projects.get("danas").whoami())).toBe("FORBIDDEN");
  expect(await codeOf(carol.projects.get("admin-project").whoami())).toBe("FORBIDDEN");
  await carol.projects.create({ project: "carols" });
  expect((await carol.projects.list()).map((p: { id: string }) => p.id)).toEqual(["carols"]);
  expect(await carol.projects.get("carols").whoami()).toEqual({ projectId: "carols", path: "/" });
  // the console knows her now: the same row the login would have made
  expect(
    await (
      await call(workersLaneEnv, "/", {
        headers: { cookie: await signIn(workersLaneEnv, "carol@example.com") },
      })
    ).text(),
  ).toContain("<code>carols</code>");

  // the refusals, coded
  expect(
    await codeOf(
      (await api(workersLaneEnv)).authenticate({ type: "admin-secret", secret: "wrong" }).whoami(),
    ),
  ).toBe("INVALID_CREDENTIALS");
  expect(
    await codeOf(
      (await api(workersLaneEnv))
        .authenticate({ type: "project-secret", project: "danas", secret: "x" })
        .whoami(),
    ),
  ).toBe("UNSUPPORTED_CREDENTIAL");
});

test("the fetch lane (/expression): a member's cookie, the project's bearer or the admin bearer admits, anyone else is 401; a visitor's `x-itx-*` headers never reach the DO's internal protocol", async () => {
  const lane = (await api(workersLaneEnv)).authenticate(ADMIN);
  const target = await lane.projects.create({ project: "lane-project" });
  // a forged pager header (the DO's internal attach protocol, which appends the events it carries)
  // is stripped at the edge: nothing lands in the log — on an admitted request, so the strip is
  // what kept it out, not the admission
  const forged = encodeURIComponent(
    JSON.stringify({
      rpcStubKey: "attack",
      appendEvents: [{ type: "events.iterate.com/stream/paused", payload: { reason: "forged" } }],
    }),
  );
  await call(workersLaneEnv, "/expression?context=lane-project&itx=itx.whoami()", {
    headers: {
      "x-itx-rpc-stub-pager": forged,
      Upgrade: "websocket",
      authorization: `Bearer ${ADMIN_API_SECRET}`,
    },
  });
  const events = (await target.readEvents(0, 100)).events as { type: string }[];
  expect(events.some((e) => e.type === "events.iterate.com/stream/paused")).toBe(false);

  // admission: a member's cookie, the admin bearer (a project-token bearer is the mcp host row
  // below); anyone else is 401
  const ada = await signIn(workersLaneEnv, "lane-ada@example.com");
  await (await api(workersLaneEnv, { cookie: ada })).authenticate(COOKIE).projects.create({
    project: "adas-lane",
  });
  const bob = await signIn(workersLaneEnv, "lane-bob@example.com");
  const laneStatus = async (headers: Record<string, string>): Promise<number> =>
    (await call(workersLaneEnv, "/expression?context=adas-lane&itx=itx.whoami()", { headers }))
      .status;
  expect(await laneStatus({ cookie: bob })).toBe(401);
  expect(await laneStatus({})).toBe(401);
  expect(await laneStatus({ authorization: "Bearer neither-a-token-nor-the-secret" })).toBe(401);
  expect(await laneStatus({ cookie: ada })).not.toBe(401); // admitted — what the lane answers for a non-fetch-shaped target is its own business
  expect(await laneStatus({ authorization: `Bearer ${ADMIN_API_SECRET}` })).not.toBe(401);
});

// THE MACHINE LANE ON A PROJECT HOST: `itx.serveMcp()` mounted as `itx.apps.mcp`, reached as
// `mcp--<p>.<base>` — the project-host spelling of the fetch lane (worker.ts), with the lane's
// directory admission and the DO dialled inside this lane. Mounted once, for the control and the pin.
const hostEnv = {
  ...workersLaneEnv,
  APP_CONFIG_PROJECT_HOSTNAME_BASE: "projects.test",
  APP_CONFIG_PROJECT_TOKEN_SECRET: "mcp-host-secret",
};
let mcpLaneMounted: Promise<void> | undefined;
/** `tools/call itx.invoke("itx.builtins.secrets.list()")` on the mounted MCP host, under `headers`. */
async function mcpLaneToolsCall(headers: Record<string, string>): Promise<Response> {
  await (mcpLaneMounted ??= (async () => {
    const ada = await signIn(hostEnv, "mcp-ada@example.com");
    const itx = await (
      await api(hostEnv, { cookie: ada })
    )
      .authenticate(COOKIE)
      .projects.create({ project: "mcp-lane" });
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
    hostEnv as never,
    createExecutionContext(),
  );
}

test("mcp--<p>.<base> serves a tools/call bearing the project's token (the control for the pin below)", async () => {
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
// no rule can mask — the WHOLE context, while the `/expression` spelling of the same lane admits
// members only (the fetch-lane test above). The library cannot see the caller's authority (it is
// written against `itx` alone), so the refusal belongs either to the ingress (a per-app admission
// the host does not have) or to the handle reading its Request's principal stamp.
test.fails("mcp--<p>.<base> refuses a tools/call carrying no principal", async () => {
  const anonymous = await mcpLaneToolsCall({});
  expect(anonymous.status, await anonymous.text()).toBe(401);
});
