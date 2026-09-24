// __workers-tests__/ingress-routes.test.ts — THE INGRESS ROUTES, end to end inside workerd: a config
// worker that asks `itx.ingressRoutes.match` for every request and forwards a match through its own
// `env.ITX.fetch` naming `itx.ingressRoutes.fetch('<name>')` — the shape `iterate tunnel` routes
// with (configs/default/worker.ts) — reaching a lent stub over a real capnweb session:
//
//   eyeball `blog--<project>.projects.test` → the edge → the context DO → the config worker (loaded)
//   → `ingressRoutes.match` (the `ingress-routes` facet's table) → `env.ITX.fetch` → the DO's
//   expression fetch `itx.ingressRoutes.fetch('tunnel-blog', request)` → the route's target
//   `itx.tunnels.blog` → the lent stub (context/rpc-stubs.ts, the fetch-upgrade leg for a socket).
//
// The WebSocket half carries a SUBPROTOCOL: a browser that asked for one (Vite's HMR client asks
// for `vite-hmr`) drops a 101 that names none, so the provider's choice must survive the upgrade
// leg and the loader hop back to the eyeball. The Node-side tunnel is pinned against a deployment
// in e2e/tunnel.e2e.test.ts.
// Run:
//   pnpm exec vitest run --project workers __workers-tests__/ingress-routes.test.ts

import { exports } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { adminCredentials, openSession, publishConfigWorker } from "./support.ts";

test("a config worker routes by `itx.ingressRoutes.match` to a lent stub: HTTP, a WebSocket that keeps its subprotocol, the private route's 401 challenge, and a 502 once the stub is gone", async () => {
  const project = "ingress-routes-tunnel";
  const itx = await createProject(project);
  const site = new LiveSite();
  const provision = await itx.provide("itx.tunnels.blog", site);
  expect(
    await itx.ingressRoutes.set("tunnel-blog", {
      requestMatcher: { routingSlug: "blog" },
      target: "itx.tunnels.blog",
    }),
  ).toEqual({ ingressRouteName: "tunnel-blog" });
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_INGRESS_ROUTER }]]);

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
  await itx.ingressRoutes.set("tunnel-blog", {
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

  // the lend recalled: the route stands, its target is not connected — a 502 naming the route
  await itx.ingressRoutes.set("tunnel-blog", {
    requestMatcher: { routingSlug: "blog" },
    target: "itx.tunnels.blog",
  });
  provision[Symbol.dispose]();
  await expect
    .poll(async () => {
      const gone = await exports.default.fetch(`https://blog--${project}.projects.test/`);
      return { status: gone.status, text: await gone.text() };
    })
    .toEqual({ status: 502, text: "tunnel-blog is not connected\n" });

  // deleted: the host is the config worker's own again
  await itx.ingressRoutes.set("tunnel-blog", null);
  expect(await itx.ingressRoutes.list()).toEqual([]);
  expect(await exports.default.fetch(`https://blog--${project}.projects.test/`)).toMatchObject({
    status: 404,
  });
});

test("itx.ingressRoutes.set validates the route before it appends and is idempotent; list and match read the table", async () => {
  const itx = await createProject("ingress-routes-table");
  await expect(
    itx.ingressRoutes.set("Not A Label", { requestMatcher: {}, target: "itx.x" }),
  ).rejects.toThrow(/DNS label/);
  await expect(
    itx.ingressRoutes.set("bad-url", {
      requestMatcher: { url: { pathname: "(" } },
      target: "itx.x",
    }),
  ).rejects.toThrow(/URLPattern/);
  const route = {
    requestMatcher: { url: { pathname: "/api/*" } },
    target: "itx.api",
    priority: 3,
  };
  await itx.ingressRoutes.set("api", route);
  const { offset } = (await itx.readEvents()).events.at(-1)!;
  await itx.ingressRoutes.set("api", route); // the same route again appends nothing
  expect((await itx.readEvents()).events.at(-1)).toMatchObject({ offset });
  expect(await itx.ingressRoutes.list()).toEqual([
    {
      ingressRouteName: "api",
      requestMatcher: { url: { pathname: "/api/*" } },
      target: ["itx", "api"],
      authRequirement: null,
      priority: 3,
      configuredOffset: offset,
    },
  ]);
  expect(
    await itx.ingressRoutes.match({
      method: "GET",
      url: "https://ingress-routes-table.projects.test/api/pets",
      headers: [["accept", "*/*"]],
    }),
  ).toMatchObject({ ingressRouteName: "api" });
  expect(
    await itx.ingressRoutes.match({
      method: "GET",
      url: "https://ingress-routes-table.projects.test/",
      headers: {},
    }),
  ).toBeNull();
  // a project resource: implicit on the root alone, and refused below it even spelled physically
  await expect(itx.cd("/notes").ingressRoutes.list()).rejects.toThrow(/no rewrite rule matches/);
  await expect(itx.cd("/notes").invoke("itx.builtins.ingressRoutes.list()")).rejects.toThrow(
    /live on its root/,
  );
});

/** THE TEMPLATE ROUTER (configs/default/worker.ts), plus a fallback: a matched request goes to
 *  its route through `env.ITX.fetch`, a private route's anonymous visitor gets the sign-in
 *  challenge, anything else is this worker's 404. */
const SRC_INGRESS_ROUTER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Router extends WorkerEntrypoint {
  async fetch(request) {
    const route = await this.env.ITX.get().ingressRoutes.match({ method: request.method, url: request.url, headers: request.headers });
    if (route) {
      if (route.authRequirement && !request.headers.get("x-itx-principal"))
        return new Response("Sign in\\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
      const headers = new Headers(request.headers);
      headers.set("x-itx-expression", \`itx.ingressRoutes.fetch(\${JSON.stringify(route.ingressRouteName)})\`);
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
