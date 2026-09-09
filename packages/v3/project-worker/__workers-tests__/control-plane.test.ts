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
//   /mcp (the last block): the ONE MCP server for every project — the metadata documents, the
//   code + PKCE flow with project selection at consent, the four tools, the admin secret and a
//   project secret as bearers, a token for another resource refused.
// The worker's default fetch is called directly so a test can hand it its own env (worker.ts's app
// config memoizes the configuration per env object).

import { createExecutionContext, env } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import definitionsSql from "../src/control-plane.sql?raw";
import { rotateProjectApiKey, signClaims } from "../src/principal.ts";
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

/** One JSON-RPC request on /mcp (`path` names it, with a query when the bearer is a project
 *  secret) under `headers`, as an MCP client sends it; the JSON-RPC message back (a JSON body, or
 *  one SSE `data:` frame), or null when the answer is not one (a 401). */
async function mcp(
  mode: Record<string, unknown>,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
  path = "/mcp",
): Promise<{ status: number; message: any; text: string; headers: Headers }> {
  const response = await call(mode, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const data = text.startsWith("event:")
    ? (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice("data:".length)
    : text;
  let message: unknown = null;
  try {
    message = JSON.parse(data);
  } catch {
    /* not JSON — the caller reads `text` */
  }
  return { status: response.status, message, text, headers: response.headers };
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

test("the admin secret: { actor: 'admin' } reaches a project the admin is no member of, lists every project, creates in org_admin; `as` is a user's session confined to their orgs; a wrong admin secret and a wrong project secret are INVALID_CREDENTIALS", async () => {
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
  ).toBe("INVALID_CREDENTIALS"); // no key rotated for danas, so nothing verifies (session-doors.test.ts has the rest)
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

  // admission: a member's cookie, the admin bearer, a project-token bearer for the project (under a
  // configuration that signs tokens — a second env object, its own configuration); anyone else is 401
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
  const tokenLaneEnv = { ...workersLaneEnv, APP_CONFIG_PROJECT_TOKEN_SECRET: "lane-token-secret" };
  const projectToken = (projectId: string) =>
    signClaims(
      { projectId, actor: "user_lane-ada@example.com", expiresAt: Date.now() + 60_000 },
      "lane-token-secret",
    );
  const tokenLaneStatus = async (token: string): Promise<number> =>
    (
      await call(tokenLaneEnv, "/expression?context=adas-lane&itx=itx.whoami()", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status;
  expect(await tokenLaneStatus(await projectToken("adas-lane"))).not.toBe(401);
  expect(await tokenLaneStatus(await projectToken("someone-elses"))).toBe(401); // a token names ONE project
});

// ── /mcp ── THE ONE MCP SERVER, for every project, behind the OAuth provider's bearer check: an
// MCP client discovers the AS through the metadata documents, registers (DCR here — the local
// lane's http origin cannot serve a CIMD document), authorizes as the cookie's user on the projects
// checked at consent, exchanges the code (PKCE S256) at /oauth/token, and calls the four tools —
// `itx.invoke` running an expression through the named project's context under the token's
// principal; the admin secret and a project's own secret are bearers too (`resolveExternalToken`).
// The MCP door on a project host that stood here (`itx.serveMcp()` mounted as `itx.apps.mcp`, and
// its red pin: an anonymous `tools/call` on `mcp--<p>.<base>` reached the whole context) is gone
// with the library member — there is no unauthenticated MCP door left to pin.

/** Where the test's OAuth client is sent back to with the code. */
const REDIRECT_URI = "https://client.test/callback";

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** The authorization-code + PKCE flow an MCP client runs, over `fetch` against the worker: DCR at
 *  /oauth/register (a public client), /authorize as the cookie's user — `choose` narrows the
 *  projects the consent page offers (all of them, checked, by default) — and the code exchanged at
 *  /oauth/token. Returns the access token and the ids the consent page offered. */
/** The flow's first half: DCR at /oauth/register (a public client) and the /authorize query with a
 *  fresh PKCE pair — what a consent page is asked with, and what a refusal is asked with. */
async function authorizeQuery(
  mode: Record<string, unknown>,
  options: { resource?: string } = {},
): Promise<{ client: { client_id: string }; verifier: string; query: URLSearchParams }> {
  const client = (await (
    await call(mode, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "control-plane.test",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
      }),
    })
  ).json()) as { client_id: string };
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: "project",
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(options.resource && { resource: options.resource }),
  });
  return { client, verifier, query };
}

async function grantFlow(
  mode: Record<string, unknown>,
  cookie: string,
  options: { resource?: string; choose?: (offered: string[]) => string[] } = {},
): Promise<{ accessToken: string; offered: string[] }> {
  const { client: registered, verifier, query } = await authorizeQuery(mode, options);
  const consent = await call(mode, `/authorize?${query}`, { headers: { cookie } });
  expect(consent.status).toBe(200);
  const offered = [
    ...(await consent.text()).matchAll(/name="project" value="([^"]+)" checked/g),
  ].map((m) => m[1]!);
  const approval = new URLSearchParams();
  for (const id of options.choose ? options.choose(offered) : offered)
    approval.append("project", id);
  const approved = await call(mode, `/authorize?${query}`, {
    method: "POST",
    body: approval,
    headers: { cookie },
  });
  expect(approved.status, await approved.text()).toBe(302);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const issued = (await (
    await call(mode, "/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registered.client_id,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        ...(options.resource && { resource: options.resource }),
      }),
    })
  ).json()) as { access_token?: string; error?: string };
  expect(issued.access_token, JSON.stringify(issued)).toBeTruthy();
  return { accessToken: issued.access_token!, offered };
}

/** `tools/call` on /mcp under `headers`: the tool result — `isError`, its text, the structured result. */
async function callTool(
  mode: Record<string, unknown>,
  headers: Record<string, string>,
  name: string,
  args: unknown,
  path = "/mcp",
): Promise<{ status: number; isError?: boolean; text: string; result?: unknown }> {
  const { status, message, text } = await mcp(
    mode,
    "tools/call",
    { name, arguments: args },
    headers,
    path,
  );
  const result = message?.result as
    | { content: { text: string }[]; structuredContent?: { result: unknown }; isError?: boolean }
    | undefined;
  if (!result) return { status, text };
  return {
    status,
    isError: result.isError,
    text: result.content[0]?.text ?? "",
    result: result.structuredContent?.result,
  };
}

test("the metadata documents: the AS names /authorize, /oauth/token and /oauth/register (S256 only, CIMD advertised); the protected resource is <origin>/mcp with this origin as its AS, at /.well-known/oauth-protected-resource and …/mcp alike; /mcp with no bearer is a 401 whose challenge points at the /mcp document", async () => {
  expect(
    await (await call(workersLaneEnv, "/.well-known/oauth-authorization-server")).json(),
  ).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    scopes_supported: ["project"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true, // wrangler.test.jsonc carries global_fetch_strictly_public
  });
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])
    expect(await (await call(workersLaneEnv, path)).json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ["project"],
    });
  const challenge = await mcp(workersLaneEnv, "tools/list", {});
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("www-authenticate")).toContain(
    `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  );
  expect(
    (await mcp(workersLaneEnv, "tools/list", {}, { authorization: "Bearer nope" })).status,
  ).toBe(401);
});

test("the code + PKCE flow: the cookie's user authorizes an MCP client on two of her three projects; the token lists the four tools, whoami is the grant; itx.invoke runs in a granted project under her principal (string and parsed forms, args appended), an expression error is an isError result; the ungranted project and a call naming none are refused", async () => {
  const ada = await signIn(workersLaneEnv, "oauth-ada@example.com");
  const session = (await api(workersLaneEnv, { cookie: ada, origin: ORIGIN })).authenticate(COOKIE);
  for (const project of ["oa-one", "oa-two", "oa-three"])
    await session.projects.create({ project });
  const { accessToken, offered } = await grantFlow(workersLaneEnv, ada, {
    resource: `${ORIGIN}/mcp`,
    choose: (ids) => ids.filter((id) => id !== "oa-three"),
  });
  expect(offered).toEqual(["oa-one", "oa-three", "oa-two"]); // every project of hers, checked, by id
  const bearer = { authorization: `Bearer ${accessToken}` };

  const listed = await mcp(workersLaneEnv, "tools/list", {}, bearer);
  expect(listed.status, listed.text).toBe(200);
  expect(listed.message.result.tools.map((t: { name: string }) => t.name)).toEqual([
    "whoami",
    "list_projects",
    "create_project",
    "itx.invoke",
  ]);
  expect(JSON.parse((await callTool(workersLaneEnv, bearer, "whoami", {})).text)).toEqual({
    sub: "user_oauth-ada@example.com",
    email: "oauth-ada@example.com",
    projects: ["oa-one", "oa-two"],
  });
  const projects = (await callTool(workersLaneEnv, bearer, "list_projects", {})).text;
  expect(projects).toContain("oa-one");
  expect(projects).toContain("oa-two");
  expect(projects).not.toContain("oa-three");

  // itx.invoke in a granted project: the context's own whoami; an append carries HER principal
  const invoke = (args: unknown) => callTool(workersLaneEnv, bearer, "itx.invoke", args);
  expect((await invoke({ project: "oa-one", expression: "itx.whoami()" })).result).toEqual({
    projectId: "oa-one",
    path: "/",
  });
  const appended = await invoke({
    project: "oa-one",
    expression: "itx.append({ type: 'note', payload: { via: 'mcp' } })",
  });
  expect(appended.isError, appended.text).toBeFalsy();
  expect((appended.result as { source: { principal: unknown } }[])[0]!.source.principal).toEqual({
    actor: "user_oauth-ada@example.com",
    email: "oauth-ada@example.com",
  });
  // args append to the terminal call; the parsed form works too; the kv is the project's
  expect(
    (await invoke({ project: "oa-two", expression: "itx.kv.put('k')", args: ["v"] })).result,
  ).toEqual({ ok: true });
  expect(
    (await invoke({ project: "oa-two", expression: ["itx", "kv", ["get", "k"]] })).result,
  ).toBe("v");
  expect((await invoke({ project: "oa-two", expression: "itx.kv.get", args: ["k"] })).result).toBe(
    "v",
  );
  expect(await session.projects.get("oa-two").kv.get("k")).toBe("v");
  expect((await invoke({ project: "oa-one", expression: "itx.kv.get('k')" })).result).toBeNull();
  // an expression error is a tool FAILURE led by its code, a 200 — never a 500
  const missing = await invoke({ project: "oa-one", expression: "itx.nope.run()" });
  expect(missing.status).toBe(200);
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("NO_ITX_EXPRESSION_MATCH");
  const unparsable = await invoke({ project: "oa-one", expression: "itx.kv.get(" });
  expect(unparsable.isError).toBe(true);
  expect(unparsable.text).toContain("expression:");
  // outside the grant; no project named on a two-project grant: the refusal names the choice
  const outside = await invoke({ project: "oa-three", expression: "itx.whoami()" });
  expect(outside.isError).toBe(true);
  expect(outside.text).toContain("outside this token's grant");
  const unnamed = await invoke({ expression: "itx.whoami()" });
  expect(unnamed.isError).toBe(true);
  expect(unnamed.text).toMatch(/pass project — this token reaches oa-one, oa-two/);
  // a project created through this token is outside its grant (the consent chose)
  const created = await callTool(workersLaneEnv, bearer, "create_project", { project: "oa-four" });
  expect(created.isError, created.text).toBeFalsy();
  expect(created.text).toContain("created project 'oa-four'");
  expect((await invoke({ project: "oa-four", expression: "itx.whoami()" })).isError).toBe(true);
});

test("a grant with nothing to choose follows membership: a user with no project authorizes, create_project through /mcp makes one, and itx.invoke reaches it with no project named", async () => {
  const eve = await signIn(workersLaneEnv, "oauth-eve@example.com");
  const { accessToken, offered } = await grantFlow(workersLaneEnv, eve);
  expect(offered).toEqual([]);
  const bearer = { authorization: `Bearer ${accessToken}` };
  expect(JSON.parse((await callTool(workersLaneEnv, bearer, "whoami", {})).text)).toEqual({
    sub: "user_oauth-eve@example.com",
    email: "oauth-eve@example.com",
  });
  const none = await callTool(workersLaneEnv, bearer, "itx.invoke", { expression: "itx.whoami()" });
  expect(none.isError).toBe(true);
  expect(none.text).toContain("reaches no project");
  const created = await callTool(workersLaneEnv, bearer, "create_project", { project: "eves" });
  expect(created.isError, created.text).toBeFalsy();
  expect((await callTool(workersLaneEnv, bearer, "list_projects", {})).text).toContain("eves");
  expect(
    (await callTool(workersLaneEnv, bearer, "itx.invoke", { expression: "itx.whoami()" })).result,
  ).toEqual({ projectId: "eves", path: "/" });
});

test("the admin secret as the bearer: whoami is { actor: 'admin' }, list_projects is the whole directory, itx.invoke must name its project and then runs as the admin; a project's own secret on /mcp?project=<id> reaches that one project as project:<id>", async () => {
  const ada = await signIn(workersLaneEnv, "mcp-admin-ada@example.com");
  await (await api(workersLaneEnv, { cookie: ada })).authenticate(COOKIE).projects.create({
    project: "adas-mcp",
  });
  const admin = { authorization: `Bearer ${ADMIN_API_SECRET}` };
  expect(JSON.parse((await callTool(workersLaneEnv, admin, "whoami", {})).text)).toEqual({
    actor: "admin",
  });
  const created = await callTool(workersLaneEnv, admin, "create_project", {
    project: "admins-mcp",
  });
  expect(created.text).toContain("(org_admin)");
  const all = (await callTool(workersLaneEnv, admin, "list_projects", {})).text;
  expect(all).toContain("adas-mcp");
  expect(all).toContain("admins-mcp");
  const invoke = (args: unknown) => callTool(workersLaneEnv, admin, "itx.invoke", args);
  const unnamed = await invoke({ expression: "itx.whoami()" });
  expect(unnamed.isError).toBe(true);
  expect(unnamed.text).toContain("pass project");
  expect((await invoke({ project: "adas-mcp", expression: "itx.whoami()" })).result).toEqual({
    projectId: "adas-mcp",
    path: "/",
  });
  const note = await invoke({
    project: "adas-mcp",
    expression: "itx.append({ type: 'note', payload: { by: 'admin' } })",
  });
  expect((note.result as { source: { principal: unknown } }[])[0]!.source.principal).toEqual({
    actor: "admin",
  });
  expect((await invoke({ project: "no:colon", expression: "itx.whoami()" })).text).toContain(
    "INVALID_CONTEXT",
  );

  // the project's own secret (principal.ts): the bearer on `/mcp?project=adas-mcp`
  const apiKey = await rotateProjectApiKey("adas-mcp", workersLaneEnv.SECRETS_KV as KVNamespace);
  const asProject = await callTool(
    workersLaneEnv,
    { authorization: `Bearer ${apiKey}` },
    "whoami",
    {},
    "/mcp?project=adas-mcp",
  );
  expect(JSON.parse(asProject.text)).toEqual({ actor: "project:adas-mcp", projects: ["adas-mcp"] });
  const asProjectNote = await callTool(
    workersLaneEnv,
    { authorization: `Bearer ${apiKey}` },
    "itx.invoke",
    { expression: "itx.append({ type: 'note', payload: { by: 'device' } })" },
    "/mcp?project=adas-mcp",
  );
  expect(asProjectNote.isError, asProjectNote.text).toBeFalsy();
  expect(
    (asProjectNote.result as { source: { principal: unknown } }[])[0]!.source.principal,
  ).toEqual({ actor: "project:adas-mcp" });
  // another project named, or none: the secret verifies for its own project only
  expect(
    (
      await mcp(
        workersLaneEnv,
        "tools/list",
        {},
        { authorization: `Bearer ${apiKey}` },
        "/mcp?project=admins-mcp",
      )
    ).status,
  ).toBe(401);
  expect(
    (await mcp(workersLaneEnv, "tools/list", {}, { authorization: `Bearer ${apiKey}` })).status,
  ).toBe(401);
});

test('a token for another resource is never issued: /authorize with a foreign `resource` is answered by the provider\'s own "Invalid authorization request" page (200, no consent, no code) — the one pinned resource is `<origin>/mcp`, so no bearer for another can ever reach /mcp', async () => {
  const cookie = await signIn(workersLaneEnv, "oauth-other@example.com");
  const { query } = await authorizeQuery(workersLaneEnv, { resource: "https://other.test/mcp" });
  const consent = await call(workersLaneEnv, `/authorize?${query}`, { headers: { cookie } });
  const body = await consent.text();
  expect(body).toContain("Invalid authorization request");
  expect(body).not.toMatch(/name="project"/); // no consent form was rendered
});
