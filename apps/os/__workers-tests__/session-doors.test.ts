import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, expect, test } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import { SRC_ECHO_APP } from "./support.ts";
const ADMIN = { type: "admin-secret", secret: env.APP_CONFIG_SECRETS__ADMIN_BEARER! } as const;
const sessions: Disposable[] = [];
const call = (url: string, init?: RequestInit) =>
  exports.default.fetch(new Request(url, { redirect: "manual", ...init }));
afterEach(() => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]();
});
async function api() {
  const response = await call("https://control.test/api", {
    headers: { Upgrade: "websocket" },
  });
  response.webSocket!.accept();
  const root = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(root);
  return root;
}

const SRC_CONFIG_ROUTER = {
  "cap.js": `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  fetch(request) {
    if (new URL(request.url).hostname === "routing-shapes.projects.test")
      return Response.json({ root: true, app: request.headers.get("x-iterate-app") });
    return new Response("no app here", { status: 404 });
  }
}`,
};

test("the host shapes: `<app>--<project>` and `<app>.<project>` reach the same app with the trusted x-iterate-app ALWAYS overwritten; the apex names no app and reaches the config worker's fetch — 404 by default, an override routes it and sees no app label", async () => {
  const admin = (await api()).authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "routing-shapes" });
  // the host label is the project's slug; the context it reaches is the project's minted id
  const { projectId } = await itx.whoami();
  expect(projectId).toMatch(/^prj_[0-9a-f]{32}$/);
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const forged = { headers: { "x-iterate-app": "other" } }; // a visitor picking an app: overwritten
  for (const host of ["echo--routing-shapes", "echo.routing-shapes"]) {
    const seen = await call(`https://${host}.projects.test/`, forged);
    expect(seen.status, await seen.clone().text()).toBe(200);
    expect(await seen.json()).toEqual({
      principal: null,
      authorization: null,
      cookie: null,
      app: "echo",
    });
  }
  // the apex: the bundled ConfigWorker's fetch — the project's bare homepage
  const apex = await call("https://routing-shapes.projects.test/", forged);
  expect(apex.status).toBe(404);
  expect(await apex.text()).toMatch(/no site yet/);
  // a project's own config worker routes the apex; the label a visitor sent is gone
  await itx.append({
    type: "events.iterate.com/project/ingress-configured",
    payload: {
      target: [
        "itx",
        "workers",
        ["get", { source: SRC_CONFIG_ROUTER, cacheKey: "config:routing-shapes" }],
      ],
    },
  });
  const routed = await call("https://routing-shapes.projects.test/", forged);
  expect(routed.status, await routed.clone().text()).toBe(200);
  expect(await routed.json()).toEqual({ root: true, app: null });
  // a label with no row stays the lane's 404
  expect((await call("https://other--routing-shapes.projects.test/")).status).toBe(404);
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
  const itx = await admin.projects.create({ project: "routing-forge" });
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
