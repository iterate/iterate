// __workers-tests__/session-doors.test.ts — THE PROJECT SECRET and THE TOKEN MINTER, pinned in the
// one local lane that binds a D1 and a KV (src/session.ts, src/iterate-context.ts, src/principal.ts,
// src/worker.ts):
//   • `projects.get(project).rotateApiKey()` mints the project's own key — a reveal IS a rotation:
//     only the hash is stored, the previous key dies, a project has none until the first call;
//   • `authenticate({ type: "project-secret", project, secret })` IS the project — `whoami` is
//     `{ projectId, actor: "project:<id>" }`, every append is stamped so, the session is bound to
//     that one project (`get` elsewhere FORBIDDEN, `list()` is the one row, `create()` FORBIDDEN);
//     a wrong key, another project's key and a never-rotated project are INVALID_CREDENTIALS;
//   • `projects.get(project).mintToken({ ttlSeconds? })` signs a project token the project-token
//     door accepts — bound to the project, carrying the minter's principal (the admin, a member,
//     the project itself), 15 minutes by default, 24 hours at most, `cd` carrying the door;
//   • THE LANES: this project's secret as `Authorization: Bearer` admits `/expression` and stamps
//     `x-itx-principal` on what the app sees; on a project host the same, the bearer stripped;
//     another project's secret is nobody — 401 on `/expression`, an unstamped pass-through on a host.
// The worker's default fetch is called directly with this lane's env plus a token secret and a
// project-host base (wrangler.test.jsonc sets neither): worker.ts's app config memoizes per env object.

import { createExecutionContext, env } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { verifyProjectToken } from "../src/principal.ts";
import worker from "../src/worker.ts";
import { applyDirectorySchema } from "./support.ts";

const TOKEN_SECRET = "session-doors-token-secret";
/** This lane's env, with the two vars the doors under test need. ONE object: the app config memo. */
const laneEnv = {
  ...(env as unknown as Record<string, unknown>),
  APP_CONFIG_PROJECT_TOKEN_SECRET: TOKEN_SECRET,
  APP_CONFIG_PROJECT_HOSTNAME_BASE: "projects.test",
};
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

  // a member (the admin's `as`): her token carries her, for her project only
  const ada = (await api()).authenticate({
    ...ADMIN,
    as: { sub: "user_ada@example.com", email: "ada@example.com" },
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

/** An app that answers with what the platform handed it: the principal stamp and the bearer. */
const SRC_ECHO = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
    });
  }
}`,
};

test("the lanes: this project's secret as the bearer admits /expression and stamps project:<id>; on a project host the app sees the stamp and never the bearer; another project's secret is 401 on /expression and an unstamped pass-through on the host", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "doors-lane" });
  await admin.projects.create({ project: "doors-lane-other" });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO }]]);
  const key = await itx.rotateApiKey();
  const foreignKey = await admin.projects.get("doors-lane-other").rotateApiKey();

  // /expression: admission, then the stamp the app sees
  const expression = (authorization: string) =>
    call("https://control.test/expression?context=doors-lane&itx=itx.apps.echo", {
      headers: { authorization },
    });
  const admitted = await expression(`Bearer ${key}`);
  expect(admitted.status, await admitted.clone().text()).toBe(200);
  expect(await admitted.json()).toEqual({
    principal: { actor: "project:doors-lane" },
    authorization: null,
  });
  expect((await expression(`Bearer ${foreignKey}`)).status).toBe(401);
  expect((await expression("Bearer not-a-key")).status).toBe(401);

  // a project host: the same stamp; another project's key is the app's own bearer, passed through
  const host = (authorization: string) =>
    call("https://echo--doors-lane.projects.test/", { headers: { authorization } });
  const seen = await host(`Bearer ${key}`);
  expect(seen.status, await seen.clone().text()).toBe(200);
  expect(await seen.json()).toEqual({
    principal: { actor: "project:doors-lane" },
    authorization: null,
  });
  expect(await (await host(`Bearer ${foreignKey}`)).json()).toEqual({
    principal: null,
    authorization: `Bearer ${foreignKey}`,
  });
});
