// __workers-tests__/session-doors.test.ts — THE PROJECT SECRET, THE TOKEN MINTER and THE PROJECT
// HOST's doors, pinned in the one local lane that binds a D1 and a KV (src/session.ts,
// src/iterate-context.ts, src/principal.ts, src/worker.ts):
//   • `projects.get(project).rotateApiKey()` mints the project's own key — a reveal IS a rotation:
//     only the hash is stored, the previous key dies, a project has none until the first call;
//   • `authenticate({ type: "project-secret", project, secret })` IS the project — `whoami` is
//     `{ projectId, actor: "project:<id>" }`, every append is stamped so, the session is bound to
//     that one project (`get` elsewhere FORBIDDEN, `list()` is the one row, `create()` FORBIDDEN);
//     a wrong key, another project's key and a never-rotated project are INVALID_CREDENTIALS;
//   • `projects.get(project).mintToken({ ttlSeconds? })` signs a project token the project-token
//     door accepts — bound to the project, carrying the minter's principal (the admin, a member,
//     the project itself), 15 minutes by default, 24 hours at most, `cd` carrying the door; a
//     project-token session is a delegation: it mints nothing and rotates nothing (FORBIDDEN); a
//     bad token and an expired token are INVALID_CREDENTIALS over /api;
//   • THE LANE: this project's secret as `Authorization: Bearer` on a project host stamps
//     `x-itx-principal` on what the app sees and never reaches it; another project's secret is
//     nobody — an unstamped pass-through; the control plane's session cookie stamps nothing;
//   • THE PROJECT HOST: `/.itx/session?token=` turns a token for THIS project into the host cookie
//     and the cookie into the principal the app sees, a foreign token is 401, `POST ?logout` clears
//     it (a GET is 405, a foreign origin's POST 403), the redirect never leaves the host; a host for
//     a project the directory does not know is 421;
//   • THE HOST SHAPES: `<app>--<project>`, `<app>.<project>` and the apex `<project>` under the base
//     (src/worker.ts `projectHostOf`) — the two app shapes reach the same `itx.apps.<app>` with the
//     trusted `x-iterate-app` ALWAYS overwritten (derived at the DO's fetch lane from the expression,
//     so loaded code forging it on `env.ITX.fetch` is overwritten too); the apex names no app and
//     reaches the config worker's `fetch` (sdk/index.ts `ConfigWorker`: the bundled default is 404,
//     an override routes); under the base a hostname that fails the grammar is 421, never the
//     control plane.
// The worker's default fetch is called directly with this lane's env (wrangler.test.jsonc: project
// hosts hang under `projects.test`).

import { createExecutionContext, env } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { signProjectToken, verifyProjectToken } from "../src/principal.ts";
import worker from "../src/worker.ts";
import { applyDirectorySchema, SRC_ECHO_APP } from "./support.ts";

/** This lane's token secret (wrangler.test.jsonc) — what a token minted over /api verifies with. */
const TOKEN_SECRET = String(
  (env as unknown as Record<string, unknown>).APP_CONFIG_PROJECT_TOKEN_SECRET,
);
/** This lane's env — ONE object: the app config memo (worker.ts `appConfigOf`). */
const laneEnv = env as unknown as Record<string, unknown>;
const ADMIN = {
  type: "admin-secret",
  secret: String((env as unknown as Record<string, unknown>).APP_CONFIG_ADMIN_API_SECRET),
} as const;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/** One request to the worker's front door, on the platform host or a project host. */
const call = (url: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(url, init), laneEnv as never, createExecutionContext());

// capnweb sessions over /api, opened on the worker's own 101; disposed at teardown.
const sessions: unknown[] = [];
/** The `UnauthenticatedSession` stub a client holds after dialing /api (a script's socket: no headers). */
async function api(): Promise<any> {
  const res = await call("https://control.test/api", { headers: { Upgrade: "websocket" } });
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

/** A device's session on `session` (an `UnauthenticatedSession` stub): the project's secret. Not
 *  awaited here — capnweb pipelines `authenticate`, and a refusal must surface on the caller's
 *  chain, where `codeOf` reads it. */
const asProject = (session: any, project: string, secret: string): any =>
  session.authenticate({ type: "project-secret", project, secret });

beforeAll(applyDirectorySchema);

test("the project secret: rotateApiKey mints it (none before the first call); the session it opens IS the project — whoami, the stamp on every append, bound to its one project; wrong keys are INVALID_CREDENTIALS; a rotation retires the previous key", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "doors-secret" });
  // no key until the first rotation
  expect(await codeOf(asProject(await api(), "doors-secret", "anything").whoami())).toBe(
    "INVALID_CREDENTIALS",
  );
  const key = await itx.rotateApiKey();
  expect(key).toMatch(BASE64URL_32_BYTES);

  const device = asProject(await api(), "doors-secret", key);
  expect(await device.whoami()).toEqual({
    projectId: "doors-secret",
    actor: "project:doors-secret",
  });
  const own = device.projects.get("doors-secret");
  expect(await own.whoami()).toEqual({ projectId: "doors-secret", path: "/" });
  const [note] = await own.append({
    type: "reading",
    payload: { celsius: 21 },
    source: { principal: { actor: "forged" } },
  });
  expect(note.source?.principal).toEqual({ actor: "project:doors-secret" }); // the DO's stamp
  // bound to its one project
  expect(await codeOf(device.projects.get("doors-other").whoami())).toBe("FORBIDDEN");
  expect(await device.projects.list()).toEqual([{ id: "doors-secret", orgId: "org_admin" }]);
  expect(await codeOf(device.projects.create({ project: "doors-by-device" }))).toBe("FORBIDDEN");
  // the refusals, coded the same
  const wrongKey = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;
  expect(await codeOf(asProject(await api(), "doors-secret", wrongKey).whoami())).toBe(
    "INVALID_CREDENTIALS",
  );
  expect(await codeOf(asProject(await api(), "doors-other", key).whoami())).toBe(
    "INVALID_CREDENTIALS",
  );

  // a rotation from the device's own handle (any handle that reaches the project may): the previous
  // key dies at once, the new one is the key
  const next = await own.rotateApiKey();
  expect(next).toMatch(BASE64URL_32_BYTES);
  expect(next).not.toBe(key);
  expect(await codeOf(asProject(await api(), "doors-secret", key).whoami())).toBe(
    "INVALID_CREDENTIALS",
  );
  expect(await asProject(await api(), "doors-secret", next).whoami()).toEqual({
    projectId: "doors-secret",
    actor: "project:doors-secret",
  });
});

test("mintToken: the admin's, a member's and the project's own handle each sign a project token the project-token door accepts — bound to the project, carrying the minter's principal, 15 minutes by default; the ttl is bounded; cd carries the door; another project's handle is refused at `get`", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "doors-mint" });
  const before = Date.now();
  const token = await itx.mintToken();
  const bearer = (await api()).authenticate({ type: "project-token", token });
  expect(await bearer.whoami()).toEqual({ projectId: "doors-mint", actor: "admin" });
  expect(await bearer.projects.get("doors-mint").whoami()).toEqual({
    projectId: "doors-mint",
    path: "/",
  });
  const claims = await verifyProjectToken(token, TOKEN_SECRET);
  expect(claims?.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
  expect(claims?.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  // a token session is a delegation, minutes long: it mints no token (no 24-hour extension of a
  // 15-minute grant) and rotates no key — FORBIDDEN, the handle carries neither door
  const delegated = bearer.projects.get("doors-mint");
  expect(await codeOf(delegated.mintToken({ ttlSeconds: 24 * 60 * 60 }))).toBe("FORBIDDEN");
  expect(await codeOf(delegated.rotateApiKey())).toBe("FORBIDDEN");

  // a member (the admin's `as`): her token carries her, for her project only
  const ada = (await api()).authenticate({
    ...ADMIN,
    as: { email: "ada@example.com" },
  });
  await ada.projects.create({ project: "adas-mint" });
  const hers = await ada.projects.get("adas-mint").mintToken({ ttlSeconds: 60 });
  expect(await (await api()).authenticate({ type: "project-token", token: hers }).whoami()).toEqual(
    { projectId: "adas-mint", actor: "user_ada@example.com", email: "ada@example.com" },
  );
  expect((await verifyProjectToken(hers, TOKEN_SECRET))?.expiresAt).toBeLessThanOrEqual(
    Date.now() + 60_000,
  );
  expect(await codeOf(ada.projects.get("doors-mint").mintToken())).toBe("FORBIDDEN"); // not hers: `get` refuses first

  // the project itself: a device's handle mints as the project
  const key = await itx.rotateApiKey();
  const device = (await api()).authenticate({
    type: "project-secret",
    project: "doors-mint",
    secret: key,
  });
  const deviceToken = await device.projects.get("doors-mint").mintToken();
  expect(
    await (await api()).authenticate({ type: "project-token", token: deviceToken }).whoami(),
  ).toEqual({ projectId: "doors-mint", actor: "project:doors-mint" });

  // the bounds, and `cd` carrying the door
  await expect(itx.mintToken({ ttlSeconds: 0 })).rejects.toThrow(/between 1 second and 24 hours/);
  await expect(itx.mintToken({ ttlSeconds: 24 * 60 * 60 + 1 })).rejects.toThrow(
    /between 1 second and 24 hours/,
  );
  expect(
    (await verifyProjectToken(await itx.cd("/agents/x").mintToken(), TOKEN_SECRET))?.projectId,
  ).toBe("doors-mint");
});

test("over /api: a bad token and an expired token are INVALID_CREDENTIALS", async () => {
  const token = await (await api()).authenticate(ADMIN).projects.get("doors-expiry").mintToken();
  const whoamiCode = (candidate: string) =>
    codeOf(
      (api() as Promise<any>).then((session) =>
        session.authenticate({ type: "project-token", token: candidate }).whoami(),
      ),
    );
  expect(await whoamiCode(`${token}x`)).toBe("INVALID_CREDENTIALS");
  expect(
    await whoamiCode(
      await signProjectToken({ projectId: "doors-expiry", actor: "admin" }, -1, TOKEN_SECRET),
    ),
  ).toBe("INVALID_CREDENTIALS");
});

test("the lane: this project's secret as the bearer on a project host stamps project:<id> and never reaches the app; another project's secret is an unstamped pass-through; a stranger's bearer too; the control plane's cookie stamps nothing", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "doors-lane" });
  await admin.projects.create({ project: "doors-lane-other" });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const key = await itx.rotateApiKey();
  const foreignKey = await admin.projects.get("doors-lane-other").rotateApiKey();

  // the stamp the app sees; another project's key, or no key at all, is the app's own bearer,
  // passed through
  const host = (authorization: string) =>
    call("https://echo--doors-lane.projects.test/", { headers: { authorization } });
  const seen = await host(`Bearer ${key}`);
  expect(seen.status, await seen.clone().text()).toBe(200);
  expect(await seen.json()).toEqual({
    principal: { actor: "project:doors-lane" },
    authorization: null,
    app: "echo",
  });
  expect(await (await host(`Bearer ${foreignKey}`)).json()).toEqual({
    principal: null,
    authorization: `Bearer ${foreignKey}`,
    app: "echo",
  });
  expect(await (await host("Bearer not-a-key")).json()).toEqual({
    principal: null,
    authorization: "Bearer not-a-key",
    app: "echo",
  });

  // the control plane's session cookie is `/api`'s credential, never a lane's: a signed-in user who
  // is no member of this project — or one who is — stamps nothing on its host
  const login = await call("https://control.test/login", {
    method: "POST",
    body: new URLSearchParams({ email: "doors-stranger@example.com", next: "/" }),
  });
  const stranger = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const seenByStranger = await call("https://echo--doors-lane.projects.test/", {
    headers: { cookie: stranger },
  });
  expect(await seenByStranger.json()).toEqual({
    principal: null,
    authorization: null,
    app: "echo",
  });
});

/** A config worker whose `fetch` routes the apex host by hostname — the tutorial's shape — echoing
 *  the (absent) app label so the edge's delete is visible. */
const SRC_CONFIG_ROUTER = {
  "cap.js": `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  fetch(request) {
    if (new URL(request.url).hostname === "doors-shapes.projects.test")
      return Response.json({ root: true, app: request.headers.get("x-iterate-app") });
    return new Response("no app here", { status: 404 });
  }
}`,
};

test("the host shapes: `<app>--<project>` and `<app>.<project>` reach the same app with the trusted x-iterate-app ALWAYS overwritten; the apex names no app and reaches the config worker's fetch — 404 by default, an override routes it and sees no app label", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "doors-shapes" });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const forged = { headers: { "x-iterate-app": "other" } }; // a visitor picking an app: overwritten
  for (const host of ["echo--doors-shapes", "echo.doors-shapes"]) {
    const seen = await call(`https://${host}.projects.test/`, forged);
    expect(seen.status, await seen.clone().text()).toBe(200);
    expect(await seen.json()).toEqual({ principal: null, authorization: null, app: "echo" });
  }
  // the apex: the bundled ConfigWorker's fetch — not found
  const apex = await call("https://doors-shapes.projects.test/", forged);
  expect(apex.status).toBe(404);
  expect(await apex.text()).toContain("Not found");
  // a project's own config worker routes the apex; the label a visitor sent is gone
  await itx.provide("itx.worker", [
    "itx",
    "workers",
    ["get", { source: SRC_CONFIG_ROUTER, cacheKey: "config:doors-shapes" }],
  ]);
  const routed = await call("https://doors-shapes.projects.test/", forged);
  expect(routed.status, await routed.clone().text()).toBe(200);
  expect(await routed.json()).toEqual({ root: true, app: null });
  // a label with no row stays the lane's 404
  expect((await call("https://other--doors-shapes.projects.test/")).status).toBe(404);
});

/** A loaded worker that fetches an app of its own project through `env.ITX.fetch`, forging the app
 *  label on the way — what the app then sees is the fetch lane's answer. */
const SRC_FORGER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Forger extends WorkerEntrypoint {
  async run() {
    const res = await this.env.ITX.fetch(new Request("https://forger.internal/", {
      headers: { "x-itx-expression": "itx.apps.echo", "x-iterate-app": "forged-by-loaded-code" },
    }));
    return { status: res.status, body: await res.json() };
  }
}`,
};

test("x-iterate-app is the fetch lane's, on every door: loaded code forging it on env.ITX.fetch is overwritten with the expression's label", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "doors-forge" });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const seen = (await itx.invoke(["itx", "workers", ["get", { source: SRC_FORGER }], ["run"]])) as {
    status: number;
    body: { app: string | null };
  };
  expect(seen.status).toBe(200);
  expect(seen.body.app).toBe("echo");
});

test("under the base, only a project host: a hostname that fails the grammar is 421 — never the control plane; the platform host itself is unaffected", async () => {
  // `site--prj_1` (an `_`), `a.b.c` (deeper than `<app>.<project>`), `--x` (no app label): none is
  // a project host, and none may be a working platform origin on a name the platform never chose
  for (const host of ["site--prj_1", "a.b.c", "--x"]) {
    const res = await call(`https://${host}.projects.test/login`, {
      method: "POST",
      body: new URLSearchParams({ email: "stranger@example.com", next: "/" }),
    });
    expect(res.status, host).toBe(421);
    expect(res.headers.get("set-cookie"), host).toBeNull();
  }
  expect((await call("https://control.test/version")).status).toBe(200);
});

test("the session door on a project host: /.itx/session?token= turns a token for THIS project into the host cookie, the cookie into the principal the app sees; a foreign token is 401; POST ?logout clears it (a GET is 405, a foreign origin's POST 403); the redirect never leaves the host; an unknown project's host is 421", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "doors-host" });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const token = await itx.mintToken();
  const host = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    call(`https://echo--doors-host.projects.test${path}`, { headers, method });

  const door = await host(`/.itx/session?token=${token}&next=/w`);
  expect(door.status, await door.clone().text()).toBe(303);
  expect(door.headers.get("location")).toBe("/w");
  const setCookie = door.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`__Host-itx-project-session=${token}`);
  expect(setCookie).toContain("HttpOnly");
  const cookie = setCookie.split(";")[0]!;
  expect(await (await host("/", { cookie: `${cookie}; theme=dark` })).json()).toEqual({
    principal: { actor: "admin" },
    authorization: null,
    app: "echo",
  });
  // a token for another project is refused at the door
  const foreign = await admin.projects.get("doors-host-other").mintToken();
  expect((await host(`/.itx/session?token=${foreign}&next=/`)).status).toBe(401);
  // logout is a POST (a GET cannot end a session; a foreign origin's POST is refused) that clears
  // the cookie; the redirect never leaves the host
  expect((await host("/.itx/session?logout&next=/")).status).toBe(405);
  expect(
    (await host("/.itx/session?logout&next=/", { origin: "https://evil.example" }, "POST")).status,
  ).toBe(403);
  const out = await host("/.itx/session?logout&next=//evil.example/x", {}, "POST");
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe("/");
  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  // a host for a project the directory does not know is 421 at the edge, before any DO is dialled
  const unknown = await call("https://echo--doors-never-created.projects.test/");
  expect(unknown.status).toBe(421);
  expect(await unknown.text()).toContain("doors-never-created");
});
