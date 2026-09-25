import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { expect, test } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import {
  catalog,
  fakeCloudflareCustomHostnames,
  ORIGIN,
  publishConfigWorker,
  releasePins,
  SRC_ECHO_APP,
  stub,
} from "./support.ts";
const ADMIN = { type: "admin-secret", secret: env.APP_CONFIG_SECRETS__ADMIN_BEARER! } as const;

const echoConfigWorker = ["itx", "workers", ["get", { source: SRC_ECHO_APP }]];

test("the edge picks the project only: `<routingSlug>--<project>`, `<routingSlug>.<project>` and the apex all reach the config worker's fetch, x-iterate-routing-slug the host's (absent on the apex) whatever a visitor sent; an unknown routing slug reaches it too; no config worker is 404", async () => {
  using session = await api();
  const admin = session.authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "routing-shapes" });
  // the host label is the project's slug; the context it reaches is the project's minted id
  const { projectId } = await itx.whoami();
  expect(projectId).toMatch(/^prj_[0-9a-f]{32}$/);
  // no config worker (ingress switched off): every host of the project is the "no site yet" 404
  await publishConfigWorker(itx, null);
  const forged = { headers: { "x-iterate-routing-slug": "other" } }; // a visitor picking a slug
  for (const host of ["routing-shapes", "echo--routing-shapes"]) {
    const none = await call(`https://${host}.projects.test/`, forged);
    expect(none, host).toMatchObject({ status: 404 });
    expect(await none.text()).toMatch(/no site yet/);
  }
  await publishConfigWorker(itx, echoConfigWorker);
  // both shapes and an unknown slug: the config worker, the header the edge's — the visitor's overwritten
  for (const [host, routingSlug] of [
    ["echo--routing-shapes", "echo"],
    ["echo.routing-shapes", "echo"],
    ["unknown--routing-shapes", "unknown"],
  ]) {
    const seen = await call(`https://${host}.projects.test/`, forged);
    expect(seen, await seen.clone().text()).toMatchObject({ status: 200 });
    expect(await seen.json()).toEqual({
      principal: null,
      authorization: null,
      cookie: null,
      routingSlug,
    });
  }
  // the apex: the same config worker, and a visitor's routing slug is deleted
  const apex = await call("https://routing-shapes.projects.test/", forged);
  expect(apex, await apex.clone().text()).toMatchObject({ status: 200 });
  expect(await apex.json()).toMatchObject({ routingSlug: null });
});

/** A loaded worker that fetches its own project through `env.ITX.fetch` — the ingress target (the
 *  empty expression, as the edge spells it) and a provided row — forging the routing slug each time:
 *  what the config worker then sees is the platform's answer. */
const SRC_FORGER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Forger extends WorkerEntrypoint {
  async run() {
    const seen = [];
    for (const expression of ["", "itx.echo"]) {
      const res = await this.env.ITX.fetch(new Request("https://forger.internal/", {
        headers: { "x-itx-expression": expression, "x-iterate-routing-slug": "forged-by-loaded-code" },
      }));
      seen.push({ status: res.status, body: await res.json() });
    }
    return seen;
  }
}`,
};

test("x-iterate-routing-slug is the edge's alone: loaded code forging it on env.ITX.fetch — even spelling the edge's empty expression — reaches the config worker with no routing slug", async () => {
  using session = await api();
  const admin = session.authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "routing-forge" });
  await publishConfigWorker(itx, echoConfigWorker);
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.echo", target: echoConfigWorker },
  });
  const seen = (await itx.invoke(["itx", "workers", ["get", { source: SRC_FORGER }], ["run"]])) as {
    status: number;
    body: { routingSlug: string | null };
  }[];
  expect(seen).toMatchObject([
    { status: 200, body: { routingSlug: null } },
    { status: 200, body: { routingSlug: null } },
  ]);
});

/** An app whose body is three chunks, 100 ms apart: still streaming after its Response is handed on. */
const SRC_SLOW_APP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Slow extends WorkerEntrypoint {
  fetch() {
    const encoder = new TextEncoder();
    let n = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.enqueue(encoder.encode("chunk-" + n + ";"));
        if (++n === 3) controller.close();
      },
    }));
  }
}`,
};

/** The config worker's router, as the SDK teaches it: one `withItx` round trip per request, released
 *  once the app's Response is in, while its body still streams. */
const SRC_WITH_ITX_ROUTER = {
  "cap.js": `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  fetch(request) {
    return this.withItx((itx) => itx.slow.fetch(request));
  }
}`,
};

test("a router that answers through this.withItx hands on the app's whole streamed body — the release after the Response does not cut it — and leaves nothing holding the context", async () => {
  const ctx = "prj_routing_withitx_stream";
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.slow",
      target: ["itx", "workers", ["get", { source: SRC_SLOW_APP }]],
    },
  });
  // What the edge sends a context for a project host's request (worker.ts): a plain fetch naming
  // the router by itx expression.
  const page = await s.fetch(
    new Request("https://router.test/", {
      headers: {
        "x-itx-expression": JSON.stringify([
          "itx",
          "workers",
          ["get", { source: SRC_WITH_ITX_ROUTER }],
        ]),
      },
    }),
  );
  expect(await page.text()).toBe("chunk-0;chunk-1;chunk-2;");
  await releasePins(ctx);
  await evictDurableObject(s); // times out after 30 s while anything still holds it
});

test("under the base, only a project host: a hostname that fails the grammar is 421 — never the control plane; the platform host itself is unaffected", async () => {
  // `site--prj_1` (an `_`), `a.b.c` (deeper than `<routingSlug>.<project>`), `--x` (no routing slug): none is
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

test("a project's own hostname: added, the processor claims it and creates its wildcard Cloudflare custom hostname (faked); the edge serves the project's config worker there, `<routingSlug>.<hostname>` with that routing slug; no other project can take it or a name under it; removed, the custom hostname is deleted and the claim released", async () => {
  const cloudflare = fakeCloudflareCustomHostnames();
  using session = await api();
  const admin = session.authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "own-hostname" });
  await publishConfigWorker(itx, [
    "itx",
    "workers",
    ["get", { source: SRC_HOSTNAME_SITE, cacheKey: "own-hostname" }],
  ]);
  const add = async (project: typeof itx, hostname: string) => {
    const [asked] = await project.append({
      type: "events.iterate.com/project/hostname-add-requested",
      payload: { hostname },
    });
    return project.waitForEvent({
      type: "events.iterate.com/project/hostname-add-settled",
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
  // the apex: the project's config worker, no routing slug
  const apex = await call("https://iterate.somedomain.test/");
  expect(apex, await apex.clone().text()).toMatchObject({ status: 200 });
  expect(await apex.json()).toEqual({ host: "iterate.somedomain.test", routingSlug: null });
  // one label under it: that routing slug, as `echo--own-hostname.projects.test` names it
  const echo = await call("https://echo.iterate.somedomain.test/");
  expect(echo, await echo.clone().text()).toMatchObject({ status: 200 });
  expect(await echo.json()).toEqual({ host: "echo.iterate.somedomain.test", routingSlug: "echo" });
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
  expect(await catalog().projectByHostname(["iterate.somedomain.test"])).toBeNull();
});

test("a project's primary hostname: once a live hostname is made primary, itx.url composes on it; a navigation on the ingress base is a 308 to the same routing slug, path and query there; a POST, a fetch and a WebSocket upgrade on the ingress base are served", async () => {
  fakeCloudflareCustomHostnames({ active: ["primary.somedomain.test"] });
  using session = await api();
  const admin = session.authenticate(ADMIN);
  const itx = await admin.projects.create({ project: "primary-hostname" });
  await publishConfigWorker(itx, [
    "itx",
    "workers",
    ["get", { source: SRC_HOSTNAME_SITE, cacheKey: "primary-hostname" }],
  ]);
  const [asked] = await itx.append({
    type: "events.iterate.com/project/hostname-add-requested",
    payload: { hostname: "primary.somedomain.test" },
  });
  expect(
    await itx.waitForEvent({
      type: "events.iterate.com/project/hostname-add-settled",
      afterOffset: asked!.offset,
      timeoutMs: 10_000,
    }),
  ).toMatchObject({ payload: { cloudflare: { status: "active", sslStatus: "active" } } });
  const [configured] = await itx.append({
    type: "events.iterate.com/project/primary-hostname-configured",
    payload: { hostname: "primary.somedomain.test" },
  });
  // the processor's cursor passes the event once the control plane holds the primary
  await itx.invoke([
    "itx",
    "facets",
    ["get", "project"],
    ["waitUntilProcessed", { offset: configured!.offset }],
  ]);

  expect(await itx.url({ routingSlug: "echo", path: "/a?b=1" })).toBe(
    "https://echo.primary.somedomain.test/a?b=1",
  );
  expect(await itx.url()).toBe("https://primary.somedomain.test/");

  const navigate = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  for (const [from, to] of [
    [
      "https://echo--primary-hostname.projects.test/a?b=1",
      "https://echo.primary.somedomain.test/a?b=1",
    ],
    ["https://primary-hostname.projects.test/", "https://primary.somedomain.test/"],
  ]) {
    const redirected = await call(from!, { headers: navigate });
    expect(redirected, from).toMatchObject({ status: 308 });
    expect(redirected.headers.get("location"), from).toBe(to);
  }
  const served = "https://echo--primary-hostname.projects.test/a?b=1";
  for (const [why, init] of [
    ["a POST", { method: "POST", headers: navigate, body: "x" }],
    ["a fetch", { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } }],
    ["a WebSocket upgrade", { headers: { ...navigate, upgrade: "websocket" } }],
  ] as const) {
    const answer = await call(served, init);
    expect(answer, why).toMatchObject({ status: 200 });
    expect(await answer.json(), why).toEqual({
      host: "echo--primary-hostname.projects.test",
      routingSlug: "echo",
    });
  }
  // on the primary hostname itself, a navigation is served
  const onPrimary = await call("https://echo.primary.somedomain.test/", { headers: navigate });
  expect(onPrimary).toMatchObject({ status: 200 });
});

/** A config worker that says which host it answered, and the routing slug it saw. */
const SRC_HOSTNAME_SITE = {
  "cap.js": `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  fetch(request) {
    return Response.json({
      host: new URL(request.url).hostname,
      routingSlug: request.headers.get("x-iterate-routing-slug"),
    });
  }
}`,
};

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
