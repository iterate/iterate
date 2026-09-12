// fetch-door.e2e.test.ts — the ONE fetch door, in and out. IN: a PROJECT HOST — a GET and a WebSocket
// upgrade on `<app>--<project>.<base>` reach whatever `itx.apps.<app>`'s fetch() is: a LOADED WORKER
// behind a rewrite rule (the site fixture — workerd-native WebSocketPair + 101) or a LENT RPC STUB
// provided by a plain NODE capnweb client (the device/ESP32 shape: `new WebSocketPair()` +
// `upgradeWebSocketResponse(pair[0])`, capnweb's universal pair + sender-side answer). OUT:
// `itx.fetch(request)` is THE egress door (the tutorial's chapter 8), a Request through the context's
// own terminal — the LAST door that owns the project scope. Layered so a regression names its hop. Pins:
//   • a loaded worker as an app: GET → 200 HTML; WebSocket upgrade → 101 echo, clean close
//   • a lent stub's plain HTTP fetch (eyeball → the project host → DO fetch lane → rule → the rpcStubs
//     registry → relay → capnweb → the Node provider and back, the request crossing intact — the
//     URL as the eyeball spelled it) and its WebSocket upgrade (101, echo, close through the Node
//     provider)
//   • a hop count the platform never wrote (`NaN`) is over budget on arrival; the deleted routes
//     /expression, /call, /ws, /cap fall through to the control plane's 404, an upgrade to /ws gets
//     no 101 — a project host is the ONE HTTP way in (who a visitor is: ingress-project-host.e2e,
//     __workers-tests__/session-doors.test.ts)
//   • egress: a `getSecret("/secrets/NAME")` placeholder that survives substitution means no such
//     secret is stored, and forwarding it would leak the secret's NAME and send a garbage credential
//     — the door scans the request (URL first, then every header) as it substitutes and answers 502
//     BEFORE the terminal fetch, naming the placeholder and where it sat to US, never to the destination
//   • DYNAMIC WORKER ⇄ DYNAMIC WORKER over a lent fetch-shaped stub, every hop native Workers RPC /
//     native fetch: within the provider's invocation a dyn-provided stub serves PLAIN fetch through
//     env.ITX (a real Fetcher, the ItxEntrypoint loopback); RED (`test.fails`): its WebSocket upgrade
//     dies on the Workers-RPC return leg, and a dyn-provided stub dies with the providing invocation
//     (the detached-provider question)
// (The workerd-provider half of the upgrade lane is __workers-tests__/ws-fetch-live-101.test.ts; a
// tunnel — `iterate tunnel bla 3000` — is the same lent stub proxying to localhost, the same hops.)

import { RpcTarget, upgradeWebSocketResponse, WebSocketPair } from "capnweb";
import { expect, test } from "vitest";
import { adminCredentials, freshCtx, openItx, session, workerUrl } from "./support/client.ts";
import {
  fetchProjectHost,
  freshDnsSafeProjectId,
  projectHostnameBase,
  registerProject,
  wsRoundTripOnProjectHost,
} from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

// ── the project host: HTTP and WebSocket, a loaded worker and a lent stub ──

test("a project host serves a LOADED WORKER as an app: GET → 200 HTML, WebSocket upgrade → 101 echo, clean close", async () => {
  const projectId = freshDnsSafeProjectId("capcode");
  await registerProject(projectId);
  // A rule whose target is a stateless dynamic worker (its .fetch serves the host) — the target is
  // an itx EXPRESSION (workers.get({ source })), same as every other rule.
  const itx = openItx(projectId);
  await itx.provide("itx.apps.site", ["itx", "workers", ["get", { source: SOURCES.site }]]);
  const host = `site--${projectId}.${projectHostnameBase()}`;

  const page = await fetchProjectHost(host, "/");
  expect(page.status, page.text).toBe(200);
  expect(page.text).toContain("dynamic web capability");

  const ws = await wsRoundTripOnProjectHost(host, "/", "hello-from-eyeball", 15_000);
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("site-echo:hello-from-eyeball");
  expect(ws.closeCode).toBe(1000);

  // observability is the core reduce's snapshot (the rewrite above already committed, so the wake
  // record has reduced)
  const snap = await itx.invoke("itx.facets.get('core').snapshot()");
  expect(typeof snap.state.incarnation).toBe("number");
});

/** A fetch-shaped live rpc stub that records what it saw (method, path AND query, body — the
 *  request must cross intact, not just some response come back) and answers a distinctive Response. */
class HttpDevice extends RpcTarget {
  saw: string[] = [];
  async fetch(request: Request) {
    const url = new URL(request.url);
    this.saw.push(
      `${request.method} ${url.host}${url.pathname}${url.search} body=${await request.text()}`,
    );
    return new Response("pong-from-node-provider", {
      status: 201,
      headers: { "x-device": "node-live-cap" },
    });
  }
}

test("lent stub HTTP fetch: an eyeball POST on the project host reaches the Node provider's fetch() and its Response rides back out", async () => {
  const projectId = freshDnsSafeProjectId("caplivehttp");
  await registerProject(projectId);
  const device = new HttpDevice();
  await session()
    .authenticate(adminCredentials())
    .projects.get(projectId)
    .provide("itx.apps.device", device);
  const host = `device--${projectId}.${projectHostnameBase()}`;

  const res = await fetchProjectHost(host, "/hunt?probe=1", {}, { method: "POST", body: "ping" });
  expect(res.status, res.text).toBe(201);
  expect(res.text).toBe("pong-from-node-provider");
  expect(res.headers["x-device"]).toBe("node-live-cap");
  expect(device.saw).toEqual([`POST ${host}/hunt?probe=1 body=ping`]); // the URL as the eyeball spelled it
});

/** The device: a fetch-shaped live rpc stub that upgrades WebSockets — the workerd fetch-handler
 *  idiom verbatim, running in Node. */
class WsDevice extends RpcTarget {
  async fetch(request: Request) {
    const upgrade = String(request?.headers?.get?.("upgrade") ?? "");
    if (upgrade.toLowerCase() !== "websocket") return new Response("http-fallback");
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].addEventListener("message", (e: { data: unknown }) =>
      pair[1].send(`device-echo:${e.data}`),
    );
    return upgradeWebSocketResponse(pair[0]);
  }
}

test("lent stub WebSocket fetch: a plain eyeball WebSocket on the project host opens (101), echoes, and closes through the Node provider", async () => {
  const projectId = freshDnsSafeProjectId("caplivews");
  await registerProject(projectId);
  await session()
    .authenticate(adminCredentials())
    .projects.get(projectId)
    .provide("itx.apps.device", new WsDevice());
  const host = `device--${projectId}.${projectHostnameBase()}`;
  // Sanity: the rule still answers plain HTTP (so the assertions below are about the UPGRADE).
  const plain = await fetchProjectHost(host, "/");
  expect(plain.text).toBe("http-fallback");

  const ws = await wsRoundTripOnProjectHost(host, "/", "hello-device");
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("device-echo:hello-device");
  expect(ws.closeCode).toBe(1000);
});

// The workerd-provider half of the same lane is pinned in __workers-tests__/ws-fetch-live-101
// .test.ts (the dedicated fetch-upgrade leg; the DO mints the eyeball pair natively). A tunnel
// (`iterate tunnel bla 3000`) is this same lent stub proxying to localhost — the same three hops.

test("a hop count the platform never wrote (an app spelling `NaN` to defeat the budget) is over budget on arrival: 508, never a loop", async () => {
  // before admission — the count is read first, so the project need not exist
  const response = await fetchProjectHost(
    `site--${freshDnsSafeProjectId("lane-nan-hops")}.${projectHostnameBase()}`,
    "/",
    { "x-itx-expression-hops": "NaN" },
  );
  expect(response.status).toBe(508);
  expect(response.text).toContain('"NaN"');
});

test("the old RPC routes are GONE — /expression, /call, /ws and /cap are no capnweb endpoint: the platform host's browser-auth gate sends an unauthenticated GET to /.auth/login (302), never an itx result; a /ws upgrade gets no 101", async () => {
  // A project host is the one HTTP way into a project. The old /expression, /call, /ws and /cap
  // routes on the platform host no longer exist as RPC doors — every non-issuer path there is behind
  // the browser-auth gate (src/sdk/auth.ts `auth.require`), so an unauthenticated GET is redirected to
  // /.auth/login. What matters for this pin: none is a capnweb/itx endpoint any more, and none upgrades.
  // (`redirect: "manual"` — a plain `fetch` would FOLLOW the 302 to the login page and see its 200.)
  for (const path of [
    "/expression?context=prj_x&itx=itx.whoami",
    "/expression/rpc/v1?context=prj_x&itx=itx.site",
    "/call?path=itx.whoami",
    "/ws",
    "/cap?context=prj_x&cap=itx.whoami",
  ]) {
    const res = await fetch(workerUrl(path), { redirect: "manual" });
    expect(res.status, path).toBe(302);
    expect(res.headers.get("location"), path).toMatch(/^\/\.auth\/login\?next=/);
  }
  const outcome = await new Promise<string>((resolve) => {
    const ws = new WebSocket(workerUrl("/ws").replace(/^http/, "ws"));
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* never opened */
      }
      resolve("no-101 (timeout)");
    }, 3_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve("101");
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve("no-101 (error)");
    });
  });
  expect(outcome).not.toBe("101");
});

// ── egress: a missing project secret is a 502 at the door ──

/** Send a Request through a fresh context's egress terminal, with test query/headers. (The URL
 *  parser percent-encodes the placeholder's quotes in the query; the door matches that form too.)
 *  The Response rides back over capnweb. */
const egress = (query: string, headers?: Record<string, string>): Promise<Response> =>
  openItx(freshCtx("egress")).fetch(
    new Request(`https://egress.invalid/hunt?probe=1${query}`, { headers }),
  );

test("a missing project secret in a HEADER is a loud 502 naming the header and the placeholder", async () => {
  const res = await egress("", { "x-hunt-auth": 'Bearer getSecret("/secrets/GHOST")' });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain('getSecret("/secrets/GHOST")'); // the placeholder is named to US, not the destination
  expect(body).toContain('header "x-hunt-auth"'); // …and WHERE it sat, so the caller can fix it
});

test("a missing project secret in the URL query is a loud 502 naming the URL — checked FIRST, before the headers", async () => {
  const res = await egress('&access_token=getSecret("/secrets/GHOST")', {
    "x-hunt-auth": 'getSecret("/secrets/GHOST")',
  });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain('getSecret("/secrets/GHOST")');
  expect(body).toContain("in the request URL");
  expect(body).not.toContain("x-hunt-auth");
});

// ── dynamic worker ⇄ dynamic worker over a lent fetch-shaped stub, WebSocket included. Provider worker
// A (loaded via `itx.workers.get({ source })`) PROVIDES a live RpcTarget whose fetch() upgrades
// WebSockets, behind the rewrite rule `itx.wsdyn`; consumer worker B fetches it through its own env.ITX
// binding with the x-itx-expression header, riding the DO's fetch lane; no capnweb client anywhere ──

const SRC_PROVIDER = {
  "cap.js": `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
class WsDevice extends RpcTarget {
  fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("dyn-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("dyn live site", { headers: { "content-type": "text/plain" } });
  }
}
export default class Provider extends WorkerEntrypoint {
  async run(mode) {
    const itx = await this.env.ITX.get();
    const device = new WsDevice();
    const provided = await itx.provide("itx.wsdyn", device);
    // Held on globalThis so nothing GC-recalls DURING this invocation; note it does NOT keep the
    // lent stub alive past the invocation (see the lifetime test below).
    globalThis.__keep = { itx, provided, device };
    if (mode === "self-plain") {
      const res = await this.env.ITX.fetch(
        new Request("https://cap.internal/", { headers: { "x-itx-expression": "itx.wsdyn" } }),
      );
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    }
    if (mode === "self-ws") {
      const res = await this.env.ITX.fetch(
        new Request("https://cap.internal/", {
          headers: { "x-itx-expression": "itx.wsdyn", Upgrade: "websocket" },
        }),
      );
      if (res.status !== 101 || !res.webSocket)
        return { status: res.status, body: (await res.text()).slice(0, 400) };
      const ws = res.webSocket;
      ws.accept();
      const echo = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve("TIMEOUT"), 8000);
        ws.addEventListener("message", (e) => {
          clearTimeout(timer);
          resolve(String(e.data));
        });
        ws.send("hi-self");
      });
      ws.close(1000, "done");
      return { status: 101, echo };
    }
    return "provided";
  }
}`,
};

const SRC_CONSUMER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Consumer extends WorkerEntrypoint {
  async run(kind) {
    if (kind === "plain") {
      const res = await this.env.ITX.fetch(
        new Request("https://cap.internal/", { headers: { "x-itx-expression": "itx.wsdyn" } }),
      );
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    }
    const res = await this.env.ITX.fetch(
      new Request("https://cap.internal/", {
        headers: { "x-itx-expression": "itx.wsdyn", Upgrade: "websocket" },
      }),
    );
    if (res.status !== 101 || !res.webSocket)
      return { status: res.status, body: (await res.text()).slice(0, 400) };
    const ws = res.webSocket;
    ws.accept();
    const echo = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("TIMEOUT"), 8000);
      ws.addEventListener("message", (e) => {
        clearTimeout(timer);
        resolve(String(e.data));
      });
      ws.send("hi-from-B");
    });
    ws.close(1000, "done");
    return { status: 101, echo };
  }
}`,
};

const runProvider = (itx: ReturnType<typeof openItx>, mode: string): Promise<unknown> =>
  itx.invoke(["itx", "workers", ["get", { source: SRC_PROVIDER }], ["run", mode]]);

test("within the provider's invocation: a dyn-provided lent stub serves PLAIN fetch", async () => {
  const itx = openItx(freshCtx("dynliveself"));
  const out = (await runProvider(itx, "self-plain")) as { status: number; body: string };
  // dyn-worker → env.ITX (Fetcher) → DO fetch lane → rewrite rule → lent stub's terminal fetch →
  // back into the SAME dyn-worker's device — a socketless Response crosses every native hop.
  expect(out).toEqual({ status: 200, body: "dyn live site" });
});

// BUG (VERIFIED, measured 2026-08-31): the fetch-upgrade dial assumes a hop that can carry
// a webSocket-bearing Response. For a CAPNWEB provider (browser/Node/workerd client over /api)
// that hop tunnels sockets (the fork's socket-as-streams) — ws-fetch-live-101 is green. For a
// NATIVE provider (a dynamic worker providing over env.ITX.get(), where the lent stub is a
// plain jsrpc stub), the dial's `provider.fetch(upgrade)` return leg IS Workers RPC — and the
// provider's genuine 101 dies there:
//   500 "DataCloneError: Could not serialize object of type WebSocket" (at dialRpcStubFetch)
// EXPECTED: parity with capnweb providers — 101 + echo. Fix directions in the session notes: the
// symmetric dial-back (the provider opens its OWN upgrade leg via its env.ITX Fetcher — it HAS
// one) or an SDK-side provider shim; the plain-fetch half (test above) already works everywhere.
test.fails("within the provider's invocation: WEBSOCKET fetch of the dyn-provided lent stub", async () => {
  const itx = openItx(freshCtx("dynlivewsself"));
  const out = (await runProvider(itx, "self-ws")) as {
    status: number;
    echo?: string;
    body?: string;
  };
  expect(out).toEqual({ status: 101, echo: "dyn-echo:hi-self" });
});

// BUG-OR-CONTRACT (VERIFIED, re-measured 2026-09-01): a dyn-provided lent STUB DIES WITH THE
// PROVIDING INVOCATION. The IterateContext scope a dynamic worker gets from env.ITX.get() lives in the
// ItxEntrypoint loopback's request context; the lend relay + pager socket holding the provider
// transport die when that context ends (the run() call chain completing), so the DO drops the
// stub from its `itx.rpcStubs` registry. The REWRITE RULE at itx.wsdyn is pure data and STAYS
// (only a disposed handle or a dying capnweb SESSION un-sets a provided stub's rule, and a dyn
// worker's env.ITX.get() scope has neither) — worker B rewrites through it and hits the offline
// registry entry, which the fetch lane reports as
//   500 "fetch lane error: … rpc stub \"itx.wsdyn\" is offline" (RPC_STUB_OFFLINE)
// — a rule with no stub lent, not default-deny; measured here as `expected 500 to be 200`.
// (holding the itx stub on the provider's globalThis does NOT keep the remote context alive).
// EXPECTED (the scenario this pins): provide in one invocation, fetch from another worker later.
// Whether the fix is a detached-provider primitive (session-shaped lending for dyn workers) or a
// doctrine ruling ("lent stubs are invocation-scoped; detached fetch-shaped things must be LOADED
// code — itx.workers.get({ source: ... }) / a named durable facet, both of which already serve WS")
// is an owner call — see the session notes.
test.fails("ACROSS invocations: worker B fetches the stub A provided (the detached-provider question)", async () => {
  const itx = openItx(freshCtx("dynlivex"));
  expect(await runProvider(itx, "provide")).toBe("provided");
  const out = (await itx.invoke([
    "itx",
    "workers",
    ["get", { source: SRC_CONSUMER }],
    ["run", "plain"],
  ])) as { status: number; body: string };
  expect(out.status).toBe(200);
  expect(out.body).toBe("dyn live site");
});
