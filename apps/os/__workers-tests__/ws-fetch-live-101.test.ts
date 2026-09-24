// __workers-tests__/ws-fetch-live-101.test.ts — THE PLATFORM QUESTION, answered by running: does
// OUR platform forward a GENUINE 101 from a LENT RPC STUB? YES — via the dedicated fetch-upgrade leg.
//
// The harness twin pinned that Node providers die
// at FABRICATION (no WebSocketPair; undici rejects status 101) — so the platform half needed a
// workerd-side provider, and THIS suite runs inside workerd. The provider lives here, lent over a
// real capnweb session; a real eyeball dials the app's project host. Every hop is
// production-shaped:
//
//   eyeball exports.default.fetch `wsdev--<project>.projects.test` → the edge sets an empty
//   x-itx-expression → the DO's itx-expression fetch resolves the project's ingress target
//   `itx.wsdev` → the rewrite rule at `itx.wsdev` (pure data: target `itx.rpcStubs.get('itx.wsdev')`,
//   the registry naming the lent provider)
//   → context/rpc-stubs.ts: the DO asks the borrowed stub to dial (an RPC call that EXECUTES in the
//   relay's session context; its return is the honest ack), the relay dials the provider's fetch()
//   over capnweb and opens ONE dedicated fetch-upgrade leg back into the DO, the DO mints the
//   eyeball's WebSocketPair natively, and frames forward RAW between the two DO-side sockets. The
//   stub pager stays a PAGER.
//
// WHY forwarded frames and not a passthrough (all dead ends measured 2026-08-31): workerd's JS RPC cannot
// serialize a webSocket-bearing Response (DataCloneError at the relay→DO return — same verdict
// when the capnweb stub itself is LOANED to the DO and dotted-called), a loopback ctx.exports
// entrypoint cannot touch the relay's capnweb session ("Cannot perform I/O on behalf of a
// different request" — I/O pins to its creating context), and proxying the socket as RPC streams
// pins the DO non-hibernatable for the socket's lifetime (evictDurableObject times out on "active
// references"). capnweb 0.12.0 carries the provider's 101 to the relay (socket-as-streams); the
// dedicated upgrade leg carries its frames the rest of the way, hibernatably.
//
// The LOADED-worker half rides the same host: a `WorkerEntrypoint`'s own 101 — here the SDK's
// `newWorkersRpcResponse` serving a capnweb API at `rpc--<project>.projects.test/<path>`, the path
// arriving verbatim — flows back through the expression fetch natively (no upgrade leg: the loader hop carries it).
// And the shape a project actually routes with: a CONFIG WORKER that branches on
// `x-iterate-routing-slug` and forwards the upgrade to the lent stub through its own `env.ITX.fetch`.
// Run:
//   pnpm exec vitest run --project workers __workers-tests__/ws-fetch-live-101.test.ts

import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { adminCredentials, openSession, publishConfigWorker } from "./support.ts";

// ─────────────── the passing halves: plain fetch works; the failing hop is NAMED ───────────────

test("plain fetch through a LENT RPC STUB: the eyeball's GET on the project host reaches the workerd provider and its 200 rides back out", async () => {
  const { site, host } = await provideLiveSite("ws101-plain");
  const page = await exports.default.fetch(host);
  const body = await page.text();
  console.log("[ws101] plain GET:", page.status, JSON.stringify(body).slice(0, 400));
  expect(page).toMatchObject({ status: 200 });
  expect(body).toBe("live site");
  expect(site.observations).toContain('fetch invoked: GET upgrade=""');
});

// ─────────────────── the platform question proper — GREEN via the fetch-upgrade leg ───────────────────

// Was VERIFIED BROKEN (a DataCloneError on the RPC return leg) until the fetch-upgrade leg
// landed; now the regression pin for the whole path: genuine 101, frames BOTH ways through every
// hop (eyeball ⇄ DO pair ⇄ upgrade leg ⇄ relay ⇄ capnweb ⇄ provider pair), clean close. Also caught on
// the way: the pager keepalive literal must be DISTINCTIVE — setWebSocketAutoResponse is DO-wide,
// so a plain "ping"/"pong" pair hijacked any eyeball frame equal to "ping".
test("lent-stub WebSocket fetch: the eyeball's upgrade on the project host gets the provider's GENUINE 101, echoes, and closes cleanly", async () => {
  const { site, host } = await provideLiveSite("ws101-correct");
  // THE CORRECT BEHAVIOR: a genuine 101 bearing a usable WebSocket…
  const res = await exports.default.fetch(host, { headers: { Upgrade: "websocket" } });
  expect(res).toMatchObject({ status: 101 });
  expect(site.observations).toContain('fetch invoked: GET upgrade="websocket"');
  expect(site.observations).toContain("fabricated a genuine 101 with a webSocket");
  const eyeball = res.webSocket;
  if (!eyeball) throw new Error("101 without a webSocket");
  // …frames flowing BOTH ways through every hop…
  const echo = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no echo within 10s")), 10_000);
    eyeball.addEventListener("message", (ev) => {
      clearTimeout(timer);
      resolve(String(ev.data));
    });
    eyeball.addEventListener("close", (ev) => {
      clearTimeout(timer);
      reject(new Error(`eyeball socket closed before the echo: ${ev.code} ${ev.reason}`));
    });
    eyeball.accept();
    eyeball.send("ping");
  });
  expect(echo).toBe("live-echo:ping");
  // …and a clean close (no dangling pumps holding the session open).
  eyeball.close(1000, "done");
});

// ─────────────────── a provider that GREETS on connect: the early server frame must not drop ───────────────────

// The primary transport (capnweb) is client-first, so this bites only RAW-WS to a provider that
// speaks first. The DO must accept the eyeball BEFORE the transport opens its upgrade leg, or the
// greeting the provider sends the instant it upgrades routes to a not-yet-existent eyeball
// (#peerOf → null) and is dropped. A regression pin for that accept-order (context/rpc-stubs.ts).
test("a lent-stub WebSocket provider that GREETS on connect: the eyeball receives the server's first frame without sending one", async () => {
  const project = "ws101-greet";
  const itx = await createProject(project);
  await itx.provide("itx.wsdev", new GreetingSite());
  await publishConfigWorker(itx, ["itx", "wsdev"]);
  const res = await exports.default.fetch(`https://wsdev--${project}.projects.test/`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res).toMatchObject({ status: 101 });
  const eyeball = res.webSocket;
  if (!eyeball) throw new Error("101 without a webSocket");
  const greeting = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no server greeting within 10s")), 10_000);
    eyeball.addEventListener("message", (ev) => {
      clearTimeout(timer);
      resolve(String(ev.data));
    });
    eyeball.addEventListener("close", (ev) => {
      clearTimeout(timer);
      reject(new Error(`eyeball closed before the greeting: ${ev.code} ${ev.reason}`));
    });
    eyeball.accept(); // NB: no eyeball.send() — the server speaks first
  });
  expect(greeting).toBe("server-hello");
  eyeball.close(1000, "done");
});

// ─────────────── the loaded-worker half: a capnweb API served by loaded code, behind the host ───────────────

/** A capnweb server as a LOADED WORKER: the SDK's `newWorkersRpcResponse` over its `fetch`. */
const SRC_CAPNWEB_SERVER = {
  "cap.js": `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "./processor.js";
class Api extends RpcTarget {
  #path;
  constructor(path) { super(); this.#path = path; }
  hello(name) { return "hello " + name; }
  path() { return this.#path; }
}
export default class CapnwebServer extends WorkerEntrypoint {
  fetch(request) {
    return newWorkersRpcResponse(request, new Api(new URL(request.url).pathname));
  }
}`,
};

test("a LOADED worker's 101 through the project host: the SDK's newWorkersRpcResponse serves a capnweb API at `rpc--<project>.<base>/<path>`, the path arriving verbatim", async () => {
  const itx = await createProject("ws101-capnweb");
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_CAPNWEB_SERVER }]]);
  const res = await exports.default.fetch("https://rpc--ws101-capnweb.projects.test/rpc/v1", {
    headers: { Upgrade: "websocket" },
  });
  expect(res).toMatchObject({ status: 101 });
  if (!res.webSocket) throw new Error("101 without a webSocket");
  res.webSocket.accept();
  const remote = newWebSocketRpcSession(res.webSocket as unknown as WebSocket) as any;
  expect(await remote.hello("host")).toBe("hello host");
  expect(await remote.path()).toBe("/rpc/v1");
  remote[Symbol.dispose]();
});

/** A config worker routing in plain code: the `wsdev` routing slug is forwarded — upgrade and all —
 *  to the lent stub at `itx.wsdev` through its own `env.ITX.fetch` (a native fetch hop, which
 *  carries a WebSocket); anything else is its 404. */
const SRC_WSDEV_ROUTER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Router extends WorkerEntrypoint {
  fetch(request) {
    if (request.headers.get("x-iterate-routing-slug") !== "wsdev")
      return new Response("no route", { status: 404 });
    const headers = new Headers(request.headers);
    headers.set("x-itx-expression", "itx.wsdev");
    return this.env.ITX.fetch(new Request(request, { headers }));
  }
}`,
};

test("a CONFIG WORKER forwards a lent stub's WebSocket: the eyeball's upgrade on `wsdev--<project>` reaches the config worker, which forwards it through env.ITX.fetch; the provider's GENUINE 101 echoes and closes cleanly", async () => {
  const project = "ws101-router";
  const site = new LiveSite();
  const itx = await createProject(project);
  await itx.provide("itx.wsdev", site);
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_WSDEV_ROUTER }]]);
  const plain = await exports.default.fetch(`https://wsdev--${project}.projects.test/`);
  expect(await plain.text()).toBe("live site");
  expect(await exports.default.fetch(`https://other--${project}.projects.test/`)).toMatchObject({
    status: 404,
  });
  const res = await exports.default.fetch(`https://wsdev--${project}.projects.test/`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res).toMatchObject({ status: 101 });
  expect(site.observations).toContain('fetch invoked: GET upgrade="websocket"');
  const eyeball = res.webSocket;
  if (!eyeball) throw new Error("101 without a webSocket");
  const echo = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no echo within 10s")), 10_000);
    eyeball.addEventListener("message", (ev) => {
      clearTimeout(timer);
      resolve(String(ev.data));
    });
    eyeball.addEventListener("close", (ev) => {
      clearTimeout(timer);
      reject(new Error(`eyeball socket closed before the echo: ${ev.code} ${ev.reason}`));
    });
    eyeball.accept();
    eyeball.send("ping");
  });
  expect(echo).toBe("live-echo:ping");
  eyeball.close(1000, "done");
});

/** The live provider: a fetch-shaped value that CAN fabricate a 101 (we are in workerd).
 *  Plain requests get a 200 page; upgrade requests get a WebSocketPair whose server side echoes
 *  every message back prefixed `live-echo:`. Observations recorded so a failure names its hop. */
class LiveSite extends RpcTarget {
  observations: string[] = [];
  fetch(request: Request): Response {
    const upgrade = (request.headers.get("Upgrade") ?? "").toLowerCase();
    this.observations.push(`fetch invoked: ${request.method} upgrade=${JSON.stringify(upgrade)}`);
    if (upgrade !== "websocket")
      return new Response("live site", { headers: { "content-type": "text/plain" } });
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].addEventListener("message", (e) => pair[1].send(`live-echo:${e.data}`));
    const response = new Response(null, { status: 101, webSocket: pair[0] });
    this.observations.push("fabricated a genuine 101 with a webSocket"); // provider-side success
    return response;
  }
}

/** The project `project`, created in the directory (a host is admitted by one directory read) —
 *  its root context on the admin session. */
async function createProject(project: string) {
  return (await openSession()).authenticate(adminCredentials()).projects.create({ project });
}

/** Provide a fresh LiveSite over a live capnweb session at `itx.wsdev` of `project` and publish that
 *  expression as the project's ingress target — every host of the project reaches the lent stub —
 *  and hand back its `wsdev` host. */
async function provideLiveSite(project: string): Promise<{ site: LiveSite; host: string }> {
  const site = new LiveSite();
  const itx = await createProject(project);
  await itx.provide("itx.wsdev", site);
  await publishConfigWorker(itx, ["itx", "wsdev"]);
  return { site, host: `https://wsdev--${project}.projects.test/` };
}

/** A provider that GREETS on connect: its first frame goes out the instant it upgrades. */
class GreetingSite extends RpcTarget {
  fetch(request: Request): Response {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket")
      return new Response("greeting site");
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].addEventListener("message", (e) => pair[1].send(`greet-echo:${e.data}`));
    pair[1].send("server-hello"); // GREET first — before any eyeball frame
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
