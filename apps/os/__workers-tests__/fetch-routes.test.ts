// __workers-tests__/fetch-routes.test.ts — THE FETCH ROUTES, end to end inside workerd: a config
// worker that asks `itx.fetchRoutes.match` for every request and forwards a match through its own
// `env.ITX.fetch` naming the route's target in `x-itx-expression` — the shape `iterate tunnel`
// routes with (configs/default/worker.ts) — reaching a lent stub over a real capnweb session:
//
//   eyeball `blog--<project>.projects.test` → the edge → the context DO → the config worker (loaded)
//   → `fetchRoutes.match` (the root's core state) → `env.ITX.fetch` → the DO's expression fetch of
//   the route's target `itx.tunnels.blog` → the lent stub (context/rpc-stubs.ts, the fetch-upgrade
//   leg for a socket).
//
// The WebSocket half carries a SUBPROTOCOL: a browser that asked for one (Vite's HMR client asks
// for `vite-hmr`) drops a 101 that names none, so the provider's choice must survive the upgrade
// leg and the loader hop back to the eyeball. The Node-side tunnel is pinned against a deployment
// in e2e/tunnel.e2e.test.ts.
// Run:
//   pnpm exec vitest run --project workers __workers-tests__/fetch-routes.test.ts

import { exports } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { expect, test, vi } from "vitest";
import { publishConfigWorker } from "../e2e/support/config-worker.ts";
import { adminCredentials, openSession } from "./support.ts";

test("a config worker routes by `itx.fetchRoutes.match` to a lent stub: HTTP, a WebSocket that keeps its subprotocol, the private route's 401 challenge, a 404 once the lend is recalled", async () => {
  const project = "fetch-routes-tunnel";
  const itx = await createProject(project);
  const site = new LiveSite();
  const provision = await itx.provide("itx.tunnels.blog", site);
  expect(
    await itx.fetchRoutes.set("tunnel-blog", {
      requestMatcher: { routingSlug: "blog" },
      target: "itx.tunnels.blog",
    }),
  ).toEqual({ fetchRouteName: "tunnel-blog" });
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_FETCH_ROUTER }]]);

  // HTTP: the matched host reaches the stub, path and query as the eyeball sent them
  const page = await exports.default.fetch(`https://blog--${project}.projects.test/a/b?c=d`);
  expect({ status: page.status, text: await page.text() }).toEqual({
    status: 200,
    text: "live site /a/b?c=d",
  });
  // no route for this host: the config worker's own answer
  const other = await exports.default.fetch(`https://other--${project}.projects.test/`);
  expect({ status: other.status, text: await other.text() }).toEqual({
    status: 404,
    text: "no route\n",
  });

  // WebSocket: the eyeball asked for two subprotocols, the provider chose one, and the eyeball's
  // 101 names it
  const upgrade = await exports.default.fetch(`https://blog--${project}.projects.test/hmr`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "vite-hmr, vite-ping" },
  });
  expect(upgrade).toMatchObject({ status: 101 });
  expect(upgrade.headers.get("sec-websocket-protocol")).toBe("vite-hmr");
  expect(site.observations).toContain('upgrade asked for "vite-hmr, vite-ping"');
  const eyeball = upgrade.webSocket;
  if (!eyeball) throw new Error("101 without a webSocket");
  expect(await echoOf(eyeball, "ping")).toBe("live-echo:ping");
  eyeball.close(1000, "done");

  // private: an anonymous visitor gets the sign-in challenge (a navigation, the edge's redirect)
  await itx.fetchRoutes.set("tunnel-blog", {
    requestMatcher: { routingSlug: "blog" },
    target: "itx.tunnels.blog",
    authRequirement: { visitors: "project-members" },
  });
  const anonymous = await exports.default.fetch(`https://blog--${project}.projects.test/`, {
    redirect: "manual",
  });
  expect(anonymous).toMatchObject({ status: 401 });
  expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="iterate"');
  const navigation = await exports.default.fetch(`https://blog--${project}.projects.test/`, {
    redirect: "manual",
    headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
  });
  expect(navigation).toMatchObject({ status: 302 });
  expect(navigation.headers.get("location")).toContain("/.auth/login");

  // the lend recalled: the rule its target named and the route go with it — the host is the
  // config worker's own again
  await itx.fetchRoutes.set("tunnel-blog", {
    requestMatcher: { routingSlug: "blog" },
    target: "itx.tunnels.blog",
  });
  provision[Symbol.dispose]();
  await expect.poll(async () => await itx.fetchRoutes.list()).toEqual([]);
  expect(await exports.default.fetch(`https://blog--${project}.projects.test/`)).toMatchObject({
    status: 404,
  });
});

test("itx.fetchRoutes.set validates the route before it appends and is idempotent; list and match read the table, which is the root's core state and no facet", async () => {
  const itx = await createProject("fetch-routes-table");
  await expect(
    itx.fetchRoutes.set("Not A Label", { requestMatcher: {}, target: "itx.x" }),
  ).rejects.toThrow(/DNS label/);
  await expect(
    itx.fetchRoutes.set("bad-url", {
      requestMatcher: { url: { pathname: "(" } },
      target: "itx.x",
    }),
  ).rejects.toThrow(/URLPattern/);
  const route = {
    requestMatcher: { url: { pathname: "/api/*" } },
    target: "itx.api",
    priority: 3,
  };
  // the root's own route events (other contexts' announcements land on the root too)
  const lastRouteEvent = async () =>
    (await itx.readEvents()).events
      .filter((event: { type: string }) =>
        event.type.startsWith("events.iterate.com/itx/fetch-route-"),
      )
      .at(-1);
  const rowsBeforeTheFirstRoute = (await itx.subscriptions.list()).map(
    (row: { name: string }) => row.name,
  );
  await itx.fetchRoutes.set("api", route);
  const { offset } = (await lastRouteEvent())!;
  await itx.fetchRoutes.set("api", route); // the same route again appends nothing
  expect(await lastRouteEvent()).toMatchObject({ offset });
  // the fact is all `set` appends — no processor row, so a request's `match` calls no facet — and
  // the table is the root's core state
  expect((await itx.subscriptions.list()).map((row: { name: string }) => row.name)).toEqual(
    rowsBeforeTheFirstRoute,
  );
  expect(await itx.facets.get("core").snapshot()).toMatchObject({
    state: { fetchRoutes: { api: { configuredOffset: offset } } },
  });
  expect(await itx.fetchRoutes.list()).toEqual([
    {
      fetchRouteName: "api",
      requestMatcher: { url: { pathname: "/api/*" } },
      target: ["itx", "api"],
      authRequirement: null,
      priority: 3,
      configuredOffset: offset,
    },
  ]);
  expect(
    await itx.fetchRoutes.match({
      url: "https://fetch-routes-table.projects.test/api/pets",
      headers: [["accept", "*/*"]],
    }),
  ).toMatchObject({ fetchRouteName: "api" });
  expect(
    await itx.fetchRoutes.match({
      url: "https://fetch-routes-table.projects.test/",
      headers: {},
    }),
  ).toBeNull();
  // a project resource: implicit on the root alone, and refused below it even spelled physically
  await expect(itx.cd("/notes").fetchRoutes.list()).rejects.toThrow(/no rewrite rule matches/);
  await expect(itx.cd("/notes").invoke("itx.builtins.fetchRoutes.list()")).rejects.toThrow(
    /live on its root/,
  );
});

test("a route whose target is a lent stub that is offline answers 502, logged at info and never reported, the header naming the expression", async () => {
  const project = "fetch-routes-offline";
  const itx = await createProject(project);
  // the rule half without the lend: the rule matches, no stub is lent under its key
  await itx.provide("itx.tunnels.ghost", "itx.rpcStubs.get('ghost')");
  await itx.fetchRoutes.set("tunnel-ghost", {
    requestMatcher: { routingSlug: "ghost" },
    target: "itx.tunnels.ghost",
  });
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_FETCH_ROUTER }]]);
  const info = vi.spyOn(console, "info");
  const error = vi.spyOn(console, "error");
  const offline = await exports.default.fetch(`https://ghost--${project}.projects.test/`);
  expect({
    status: offline.status,
    rpcStubOffline: offline.headers.get("x-iterate-rpc-stub-offline"),
  }).toEqual({ status: 502, rpcStubOffline: '["itx","tunnels","ghost"]' });
  expect(info).toHaveBeenCalledWith({
    event: "expression-fetch.rpc-stub-offline",
    itxExpression: '["itx","tunnels","ghost"]',
  });
  expect(error).not.toHaveBeenCalled();
});

/** THE TEMPLATE ROUTER (configs/default/worker.ts), plus a fallback: a matched request goes to
 *  its route through `env.ITX.fetch`, a private route's anonymous visitor gets the sign-in
 *  challenge, anything else is this worker's 404. */
const SRC_FETCH_ROUTER = {
  "worker.js": `import { ConfigWorker } from "iterate/sdk";
export default class Router extends ConfigWorker {
  async fetch(request) {
    const route = await this.withItx((itx) => itx.fetchRoutes.match({ url: request.url, headers: request.headers }));
    if (route?.authRequirement && !request.headers.has("x-itx-principal"))
      return new Response("Sign in\\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
    if (route) {
      const headers = new Headers(request.headers);
      headers.set("x-itx-expression", JSON.stringify(route.target));
      return this.env.ITX.fetch(new Request(request, { headers }));
    }
    return new Response("no route\\n", { status: 404 });
  }
}`,
};

/** The lent provider, as `iterate tunnel`'s local proxy is: a page naming the path it was asked
 *  for, and an upgrade that echoes and chooses the first subprotocol the eyeball offered. */
class LiveSite extends RpcTarget {
  observations: string[] = [];
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket")
      return new Response(`live site ${url.pathname}${url.search}`);
    const offered = request.headers.get("Sec-WebSocket-Protocol") ?? "";
    this.observations.push(`upgrade asked for ${JSON.stringify(offered)}`);
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].addEventListener("message", (e) => pair[1].send(`live-echo:${e.data}`));
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": offered.split(",")[0]!.trim() },
    });
  }
}

/** Accept `eyeball`, send `message`, answer the first frame back. */
function echoOf(eyeball: WebSocket, message: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no echo within 10s")), 10_000);
    eyeball.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(String(event.data));
    });
    eyeball.addEventListener("close", (event) => {
      clearTimeout(timer);
      reject(new Error(`eyeball closed before the echo: ${event.code} ${event.reason}`));
    });
    eyeball.accept();
    eyeball.send(message);
  });
}

/** The project `project` on the admin session. */
async function createProject(project: string) {
  return (await openSession()).authenticate(adminCredentials()).projects.create({ project });
}
