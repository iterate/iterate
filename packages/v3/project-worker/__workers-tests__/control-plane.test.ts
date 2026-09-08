// __workers-tests__/control-plane.test.ts — the in-process control plane's doors (src/control-plane),
// pinned in the one local lane that binds a D1. EMAIL login mode: the login form, the session cookie,
// a project created as that user and listed on the console, a taken name refused, the same-origin
// redirect, and /mcp behind the OAuth bearer. OPEN login mode (this lane's own configuration):
// every visitor is the anonymous identity — a /login cookie cannot make a second one — and /mcp is
// tokenless. The worker's default fetch is called directly so each mode gets its own env
// (app-config.ts memoizes the configuration per env object).

import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import definitionsSql from "../src/control-plane/definitions.sql?raw";
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
const json = (body: unknown, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(cookie && { cookie }) },
  body: JSON.stringify(body),
});

/** The JSON-RPC result of an /mcp answer — a JSON body, or (a tool call) one SSE `data:` frame. */
async function mcpResult(response: Response): Promise<{ content: { text: string }[] }> {
  const text = await response.text();
  const data = text.startsWith("event:")
    ? (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice("data:".length)
    : text;
  return (JSON.parse(data) as { result: { content: { text: string }[] } }).result;
}

/** A JSON-RPC call on /mcp (the json response mode: one JSON body per request). */
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

test("email mode: the login form → a session cookie → a project created as that user and listed; a taken name is refused; the redirect never leaves the origin; /mcp wants a bearer", async () => {
  const anonymousHome = await call(emailMode, "/");
  expect(anonymousHome.status).toBe(200);
  expect(await anonymousHome.text()).toContain("Sign in");

  const login = await call(
    emailMode,
    "/login",
    form({ email: "Ada@Example.com", next: "//evil.example/x" }),
  );
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/"); // a foreign origin falls back to "/"
  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^itx-control-plane-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly/);
  const cookie = setCookie.split(";")[0];

  expect(await (await call(emailMode, "/", { headers: { cookie } })).text()).toContain(
    "Signed in as ada@example.com",
  );

  const created = await call(emailMode, "/projects", json({ slug: "My Project" }, cookie));
  expect(created.status).toBe(200);
  const project = (await created.json()) as { id: string; orgId: string };
  expect(project.id).toBe("my-project"); // the id IS the slugified name
  expect(project.orgId).toMatch(/^org_/);
  expect(await (await call(emailMode, "/", { headers: { cookie } })).text()).toContain(
    "<code>my-project</code>",
  );
  // the same user again: idempotent
  expect(
    (
      (await (await call(emailMode, "/projects", json({ slug: "my-project" }, cookie))).json()) as {
        id: string;
      }
    ).id,
  ).toBe("my-project");

  // another user cannot take the name
  const other = (
    await call(emailMode, "/login", form({ email: "bob@example.com", next: "/" }))
  ).headers
    .get("set-cookie")!
    .split(";")[0];
  const taken = await call(emailMode, "/projects", json({ slug: "my-project" }, other));
  expect(taken.status).toBe(409);
  expect(await taken.json()).toEqual({ error: "project name 'my-project' is already taken" });

  // no cookie: no project — back to the login page
  expect((await call(emailMode, "/projects", json({ slug: "nope" }))).status).toBe(302);
  // /mcp is the OAuth-protected boundary: without a bearer the provider refuses
  expect((await mcp(emailMode, "initialize", {})).status).toBe(401);
  // logout clears the cookie
  const logout = await call(emailMode, "/logout", { method: "POST" });
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("open mode (this lane's configuration): every visitor is the anonymous identity — the console, project creation, and a tokenless /mcp whoami; a /login cookie cannot make a second identity", async () => {
  expect(await (await call(openMode, "/")).text()).toContain("Signed in as anonymous");
  const created = await call(openMode, "/projects", json({ slug: "open-project" }));
  expect(((await created.json()) as { id: string }).id).toBe("open-project");
  expect(await (await call(openMode, "/")).text()).toContain("<code>open-project</code>");

  const login = await call(openMode, "/login", form({ email: "mallory@example.com", next: "/" }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  expect(await (await call(openMode, "/", { headers: { cookie } })).text()).toContain(
    "Signed in as anonymous",
  );

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
    projectId: null,
  });
  const listed = await mcp(
    openMode,
    "tools/call",
    { name: "list_projects", arguments: {} },
    sessionId,
  );
  expect((await mcpResult(listed)).content[0].text).toContain("open-project");
});
