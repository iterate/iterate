// fetch-routes.e2e.test.ts — `itx.fetchRoutes` through `/api`, exactly as a production client
// (the `iterate tunnel` CLI) spells it: a route set on the project's root, a config worker shaped
// like the template's (configs/default/worker.ts) asking `match` and forwarding through its own
// `env.ITX.fetch`, and a fetch-shaped stub lent by a plain Node capnweb client — the tunnel's shape
// minus the local port (the CLI itself is e2e/tunnel.e2e.test.ts). Pins:
//   • HTTP reaches the lent stub on the route's host; a host no route takes is the config worker's
//   • a WebSocket asking for a subprotocol (Vite's HMR asks for `vite-hmr`) opens: the provider's
//     choice rides back to the eyeball's 101, or a spec-following client refuses the handshake
//   • a private route: an anonymous page load is sent to sign in, an anonymous fetch gets the 401
//   • the lend recalled: 502 naming the route; the route deleted: the config worker's own answer
//   • `set` refuses a malformed route and appends nothing for a route that stands
// The workerd twin (no network) is __workers-tests__/fetch-routes.test.ts.

import { RpcTarget, upgradeWebSocketResponse, WebSocketPair } from "capnweb";
import { expect, test } from "vitest";
import { adminCredentials, rejection, session, untilValue } from "./support/client.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  navigateProjectUrl,
  projectUrl,
  publishConfigWorker,
  registerProject,
  wsRoundTripOnProjectUrl,
} from "./support/project-host.ts";

test("a route to a lent stub: HTTP, a WebSocket keeping its subprotocol, the private route's sign-in, a 502 once the stub is gone, and the host back to the config worker once the route is deleted", async () => {
  const slug = freshDnsSafeProjectSlug("fetch-routes");
  const projectId = await registerProject(slug);
  const itx = session().authenticate(adminCredentials()).projects.get(projectId);
  const provision = await itx.provide("itx.tunnels.blog", new LocalSite());
  const route = { requestMatcher: { routingSlug: "blog" }, target: "itx.tunnels.blog" };
  await itx.fetchRoutes.set("tunnel-blog", route);
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_FETCH_ROUTER }]]);
  const blog = projectUrl({ project: slug, routingSlug: "blog", path: "/" });

  expect(await fetchProjectUrl(blog)).toMatchObject({ status: 200, text: "local site" });
  expect(
    await fetchProjectUrl(projectUrl({ project: slug, routingSlug: "other", path: "/" })),
  ).toMatchObject({ status: 404, text: "no route\n" });
  const ws = await wsRoundTripOnProjectUrl(blog, "hello", 15_000, ["vite-hmr"]);
  expect(ws).toMatchObject({
    opened: true,
    protocol: "vite-hmr",
    echo: "local-echo:hello",
    closeCode: 1000,
  });

  await itx.fetchRoutes.set("tunnel-blog", {
    ...route,
    authRequirement: { visitors: "project-members" },
  });
  const navigation = await navigateProjectUrl(blog, {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  });
  expect(navigation).toMatchObject({ status: 302 });
  expect(navigation.headers.location).toContain("/.auth/login");
  expect(await fetchProjectUrl(blog)).toMatchObject({ status: 401, text: "Sign in\n" });

  await itx.fetchRoutes.set("tunnel-blog", route);
  provision[Symbol.dispose]();
  expect(
    await untilValue(
      "the recalled tunnel answers 502",
      () => fetchProjectUrl(blog),
      (page) => page.status === 502,
    ),
  ).toMatchObject({ status: 502, text: "tunnel-blog is not connected\n" });

  await itx.fetchRoutes.set("tunnel-blog", null);
  expect(await itx.fetchRoutes.list()).toEqual([]);
  expect(await fetchProjectUrl(blog)).toMatchObject({ status: 404, text: "no route\n" });
});

test("itx.fetchRoutes.set refuses a malformed route (INVALID_INPUT) before it appends and appends nothing for a route that already stands", async () => {
  const projectId = await registerProject(freshDnsSafeProjectSlug("fetch-routes-set"));
  const itx = session().authenticate(adminCredentials()).projects.get(projectId);
  for (const [name, route] of [
    ["Tunnel_Blog", { requestMatcher: {}, target: "itx.x" }],
    ["no-target", { requestMatcher: {} }],
    ["bad-url", { requestMatcher: { url: { pathname: "(" } }, target: "itx.x" }],
  ] as const)
    expect(await rejection(itx.fetchRoutes.set(name, route)), name).toMatchObject({
      code: "INVALID_INPUT",
    });
  // The route's own facts, not the log's head: the root's log also takes facts nobody here asked
  // for, e.g. a child context's `itx/child-created` landing between two reads.
  const routeFacts = async () =>
    (await itx.readEvents()).events.filter(
      (event: { type: string; offset: number }) =>
        event.type === "events.iterate.com/itx/fetch-route-configured",
    );
  const route = { requestMatcher: { url: { pathname: "/api/*" } }, target: "itx.api" };
  await itx.fetchRoutes.set("api", route);
  const facts = await routeFacts();
  expect(facts).toHaveLength(1);
  await itx.fetchRoutes.set("api", route);
  expect(await routeFacts()).toEqual(facts);
  expect(await itx.fetchRoutes.list()).toMatchObject([
    { fetchRouteName: "api", target: ["itx", "api"], configuredOffset: facts[0]?.offset },
  ]);
});

/** The template's router (configs/default/worker.ts) with a 404 of its own. */
const SRC_FETCH_ROUTER = {
  "cap.js": `import { ConfigWorker } from "./processor.js";
export default class Router extends ConfigWorker {
  async fetch(request) {
    const route = await this.withItx((itx) => itx.fetchRoutes.match({ method: request.method, url: request.url, headers: request.headers }));
    if (route) {
      if (route.authRequirement && !request.headers.get("x-itx-principal"))
        return new Response("Sign in\\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
      const headers = new Headers(request.headers);
      headers.set("x-itx-expression", \`itx.fetchRoutes.fetch(\${JSON.stringify(route.fetchRouteName)})\`);
      return this.env.ITX.fetch(new Request(request, { headers }));
    }
    return new Response("no route\\n", { status: 404 });
  }
}`,
};

/** What a tunnel lends, running in Node: a page, and an upgrade that echoes and chooses the first
 *  subprotocol the eyeball offered. */
class LocalSite extends RpcTarget {
  async fetch(request: Request) {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
      return new Response("local site");
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].addEventListener("message", (e: { data: unknown }) =>
      pair[1].send(`local-echo:${e.data}`),
    );
    const offered = request.headers.get("sec-websocket-protocol") ?? "";
    return upgradeWebSocketResponse(pair[0], {
      headers: { "Sec-WebSocket-Protocol": offered.split(",")[0]!.trim() },
    });
  }
}
