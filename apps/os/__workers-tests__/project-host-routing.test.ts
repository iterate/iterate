import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import { ORIGIN, SRC_ECHO_APP } from "./support.ts";
const ADMIN = { type: "admin-secret", secret: env.APP_CONFIG_SECRETS__ADMIN_BEARER! } as const;

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
  using session = await api();
  const admin = session.authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "routing-shapes" });
  // the host label is the project's slug; the context it reaches is the project's minted id
  const { projectId } = await itx.whoami();
  expect(projectId).toMatch(/^prj_[0-9a-f]{32}$/);
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const forged = { headers: { "x-iterate-app": "other" } }; // a visitor picking an app: overwritten
  for (const host of ["echo--routing-shapes", "echo.routing-shapes"]) {
    const seen = await call(`https://${host}.projects.test/`, forged);
    expect(seen, await seen.clone().text()).toMatchObject({ status: 200 });
    expect(await seen.json()).toEqual({
      principal: null,
      authorization: null,
      cookie: null,
      app: "echo",
    });
  }
  // the apex: the bundled ConfigWorker's fetch — the project's bare homepage
  const apex = await call("https://routing-shapes.projects.test/", forged);
  expect(apex).toMatchObject({ status: 404 });
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
  expect(routed, await routed.clone().text()).toMatchObject({ status: 200 });
  expect(await routed.json()).toEqual({ root: true, app: null });
  // a label with no row stays the expression fetch's 404
  expect(await call("https://other--routing-shapes.projects.test/")).toMatchObject({ status: 404 });
});

/** A loaded worker that fetches an app of its own project through `env.ITX.fetch`, forging the app
 *  label on the way — what the app then sees is the expression fetch's answer. */
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

test("x-iterate-app is the expression fetch's, on every route in: loaded code forging it on env.ITX.fetch is overwritten with the expression's label", async () => {
  using session = await api();
  const admin = session.authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "routing-forge" });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const seen = (await itx.invoke(["itx", "workers", ["get", { source: SRC_FORGER }], ["run"]])) as {
    status: number;
    body: { app: string | null };
  };
  expect(seen).toMatchObject({ status: 200, body: { app: "echo" } });
});

test("under the base, only a project host: a hostname that fails the grammar is 421 — never the control plane; the platform host itself is unaffected", async () => {
  // `site--prj_1` (an `_`), `a.b.c` (deeper than `<app>.<project>`), `--x` (no app label): none is
  // a project host, and none may be a working platform ORIGIN on a name the platform never chose
  for (const host of ["site--prj_1", "a.b.c", "--x"]) {
    const res = await call(`https://${host}.projects.test/login`, {
      method: "POST",
      body: new URLSearchParams({ email: "stranger@example.com", next: "/" }),
    });
    expect(res, host).toMatchObject({ status: 421 });
    expect(res.headers.get("set-cookie"), host).toBeNull();
  }
  expect(await call(`${ORIGIN}/version`)).toMatchObject({ status: 200 });
});

test("a project's own hostname: added, the processor claims it and creates its wildcard Cloudflare custom hostname (faked); the edge serves the project's apex there and `<app>.<hostname>` its apps; no other project can take it or a name under it; removed, the custom hostname is deleted and the claim released", async () => {
  const cloudflare = fakeCloudflareCustomHostnames();
  using session = await api();
  const admin = session.authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "own-hostname" });
  await itx.append({
    type: "events.iterate.com/project/ingress-configured",
    payload: {
      target: ["itx", "workers", ["get", { source: SRC_HOSTNAME_SITE, cacheKey: "own-hostname" }]],
    },
  });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const add = async (project: typeof itx, hostname: string) => {
    const [asked] = await project.append({
      type: "events.iterate.com/project/hostname-add-requested",
      payload: { hostname },
    });
    return project.waitForEvent({
      type: "events.iterate.com/project/hostname-add-answered",
      afterOffset: asked!.offset,
      timeoutMs: 10_000,
    });
  };
  expect(await add(itx, "iterate.somedomain.test")).toMatchObject({
    payload: {
      hostname: "iterate.somedomain.test",
      error: null,
      cloudflare: {
        status: "pending",
        records: [
          { name: "iterate.somedomain.test", value: "cname.saas.test" },
          { name: "*.iterate.somedomain.test", value: "cname.saas.test" },
          {
            name: "_acme-challenge.iterate.somedomain.test",
            value: "iterate.somedomain.test.dcv-uuid.dcv.cloudflare.com",
          },
        ],
      },
    },
  });
  expect(cloudflare).toMatchObject({ hostnames: ["iterate.somedomain.test"] });
  // the apex: the project's config worker, no app label
  const apex = await call("https://iterate.somedomain.test/");
  expect(apex, await apex.clone().text()).toMatchObject({ status: 200 });
  expect(await apex.json()).toEqual({ host: "iterate.somedomain.test", app: null });
  // one label under it: that app, as `echo--own-hostname.projects.test` is
  const app = await call("https://echo.iterate.somedomain.test/");
  expect(app, await app.clone().text()).toMatchObject({ status: 200 });
  expect(await app.json()).toMatchObject({ app: "echo" });
  // another project cannot take it or a name under it; the deployment's own zones are refused
  const other = await admin.projects.create({ project: "own-hostname-other" });
  for (const hostname of [
    "iterate.somedomain.test",
    "echo.iterate.somedomain.test",
    "x.projects.test",
  ])
    expect(await add(other, hostname)).toMatchObject({
      payload: { hostname, cloudflare: null, error: expect.any(String) },
    });
  const [removal] = await itx.append({
    type: "events.iterate.com/project/hostname-remove-requested",
    payload: { hostname: "iterate.somedomain.test" },
  });
  await itx.waitForEvent({
    type: "events.iterate.com/project/hostname-removed",
    afterOffset: removal!.offset,
    timeoutMs: 10_000,
  });
  expect(cloudflare).toMatchObject({ hostnames: [] });
  expect(
    await env.CONTROL_PLANE.getByName("global").projectByHostname(["iterate.somedomain.test"]),
  ).toBeNull();
});

/** A config worker that says which host it answered, and the app label it saw. */
const SRC_HOSTNAME_SITE = {
  "cap.js": `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  fetch(request) {
    return Response.json({ host: new URL(request.url).hostname, app: request.headers.get("x-iterate-app") });
  }
}`,
};

/** Cloudflare's custom-hostname API on the SaaS zone (wrangler.test.jsonc `saas.test`), faked in
 *  this isolate's `fetch`; every other request goes through. */
function fakeCloudflareCustomHostnames() {
  const hostnames: string[] = [];
  const through = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.cloudflare.com") return through(request);
    const ok = (result: unknown) => Response.json({ success: true, result });
    const entry = (hostname: string) => ({ id: `ch-${hostname}`, hostname, status: "pending" });
    if (url.pathname.endsWith("/zones")) return ok([{ id: "zone-saas" }]);
    if (request.method === "POST") {
      const { hostname } = (await request.json()) as { hostname: string };
      hostnames.push(hostname);
      return ok(entry(hostname));
    }
    if (request.method === "DELETE") {
      hostnames.splice(hostnames.indexOf(url.pathname.split("/ch-")[1]!), 1);
      return ok({});
    }
    const asked = url.searchParams.get("hostname");
    return ok(hostnames.filter((hostname) => hostname === asked).map(entry));
  });
  onTestFinished(() => spy.mockRestore());
  return { hostnames };
}

function call(url: string, init?: RequestInit) {
  return exports.default.fetch(new Request(url, { redirect: "manual", ...init }));
}

/** A capnweb session over the worker's /api; the test that opens it disposes it (`using`). */
async function api() {
  const response = await call(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
  });
  response.webSocket!.accept();
  return newWebSocketRpcSession<IterateRpcTarget>(response.webSocket! as unknown as WebSocket);
}
