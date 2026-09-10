import { env, SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeAll, expect, test } from "vitest";
import type { UnauthenticatedSession } from "../src/session.ts";
import { signProjectToken, rotateProjectApiKey } from "../src/principal.ts";
import type { Env } from "../src/control-plane.ts";
import { applyDirectorySchema, SRC_ECHO_APP } from "./support.ts";

const bindings = env as unknown as Env;
const ADMIN = { type: "admin-secret", secret: bindings.APP_CONFIG_ADMIN_API_SECRET! } as const;
const sessions: Disposable[] = [];
const call = (url: string, init?: RequestInit) =>
  SELF.fetch(new Request(url, { redirect: "manual", ...init }));
beforeAll(applyDirectorySchema);
afterEach(() => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]();
});
async function api() {
  const response = await call("https://control.test/internal/rpc", {
    headers: { Upgrade: "websocket" },
  });
  response.webSocket!.accept();
  const root = newWebSocketRpcSession<UnauthenticatedSession>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(root);
  return root;
}

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

test("legacy project credentials never authenticate public resources or the operator gate", async () => {
  const gate = await api();
  const admin = await gate.authenticate(ADMIN);
  using project = await admin.projects.create({ project: "retired-credentials" });
  await project.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const token = await signProjectToken(
    { actor: "former-user", projectId: "retired-credentials" },
    60_000,
    bindings.APP_CONFIG_PROJECT_TOKEN_SECRET!,
  );
  const key = await rotateProjectApiKey("retired-credentials", bindings.SECRETS_KV);
  for (const value of [token, key]) {
    for (const url of [
      "https://control.test/api",
      "https://control.test/mcp",
      "https://echo--retired-credentials.projects.test/",
    ])
      expect((await call(url, { headers: { Authorization: `Bearer ${value}` } })).status).toBe(401);
  }
  await expect(gate.authenticate({ type: "project-token", token })).rejects.toThrow(/admin secret/);
  await expect(
    gate.authenticate({ type: "project-secret", project: "retired-credentials", secret: key }),
  ).rejects.toThrow(/admin secret/);
  const legacy = await call(
    `https://echo--retired-credentials.projects.test/.itx/session?token=${encodeURIComponent(token)}`,
  );
  expect(legacy.headers.has("set-cookie")).toBe(false);
  expect(await legacy.json()).toMatchObject({ principal: null });
});
