// fetch-door.e2e.test.ts — the ONE fetch door, in and out. IN: `/expression` — a GET and a WebSocket
// upgrade reach whatever the named itx expression's fetch() is: a LOADED WORKER behind a rewrite rule
// (the site fixture — workerd-native WebSocketPair + 101) or a LENT RPC STUB provided by a plain NODE
// capnweb client (the device/ESP32 shape: `new WebSocketPair()` + `upgradeWebSocketResponse(pair[0])`,
// capnweb's universal pair + sender-side answer). OUT: `itx.fetch(request)` is THE egress door (the
// tutorial's chapter 2), a Request through the context's own terminal — the LAST door that owns the
// project scope. Layered so a regression names its hop. Pins:
//   • a loaded worker behind a rule: GET → 200 HTML, CSP-sandboxed to an opaque origin (loaded code's
//     document, served on the platform's origin, can never reach `/api` with the visitor's session);
//     WebSocket upgrade → 101 echo, clean close
//   • a lent stub's plain HTTP fetch (eyeball → /expression → DO fetch lane → rule → the rpcStubs
//     registry → relay → capnweb → the Node provider and back, the request crossing intact) and its
//     WebSocket upgrade (101, echo, close through the Node provider)
//   • the lane refuses to re-enter itself (`itx=itx.fetch` answers 508 after a few hops, never loops); a
//     hop count the platform never wrote (`NaN`) is over budget on arrival; the deleted routes /call,
//     /ws, /cap fall through to the control plane's 404, an upgrade to /ws gets no 101
//   • egress: a `{{secret:project:NAME}}` token that survives substitution means no such secret is
//     stored, and forwarding it would leak the secret's NAME and send a garbage credential — the door
//     scans the request (URL first, then every header) as it substitutes and answers 502 BEFORE the
//     terminal fetch, naming the token and where it sat to US, never to the destination
//   • DYNAMIC WORKER ⇄ DYNAMIC WORKER over a lent fetch-shaped stub, every hop native Workers RPC /
//     native fetch: within the provider's invocation a dyn-provided stub serves PLAIN fetch through
//     env.ITX (a real Fetcher, the ItxEntrypoint loopback); RED (`test.fails`): its WebSocket upgrade
//     dies on the Workers-RPC return leg, and a dyn-provided stub dies with the providing invocation
//     (the detached-provider question)
// (The workerd-provider half of the upgrade lane is __workers-tests__/ws-fetch-live-101.test.ts; a
// tunnel — `iterate tunnel bla 3000` — is the same lent stub proxying to localhost, the same hops.)

import { RpcTarget, upgradeWebSocketResponse, WebSocketPair } from "capnweb";
import { expect, test } from "vitest";
import {
  expressionUrl,
  freshCtx,
  openItx,
  session,
  workerUrl,
  wsRoundTrip,
} from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

// ── /expression: HTTP and WebSocket, a loaded worker and a lent stub ──

test("/expression serves a LOADED WORKER behind a rewrite rule: GET → 200 HTML, WebSocket upgrade → 101 echo, clean close", async () => {
  const ctx = freshCtx("capcode");
  // A rule whose target is a stateless dynamic worker (its .fetch serves /expression) — the target
  // is an itx EXPRESSION (workers.get({ source })), same as every other rule.
  const itx = openItx(ctx);
  await itx.provide("itx.site", ["itx", "workers", ["get", { source: SOURCES.site }]]);

  const page = await fetch(expressionUrl(ctx, "itx.site", "http"));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("dynamic web capability");
  // Loaded code's document, served on the PLATFORM's origin: CSP-sandboxed to an opaque origin, so
  // its script can never reach `/api` with the visitor's session (scripts and forms still run).
  expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms");

  const ws = await wsRoundTrip(expressionUrl(ctx, "itx.site", "ws"), "hello-from-eyeball", 15_000);
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
    this.saw.push(`${request.method} ${url.pathname}${url.search} body=${await request.text()}`);
    return new Response("pong-from-node-provider", {
      status: 201,
      headers: { "x-device": "node-live-cap" },
    });
  }
}

test("lent stub HTTP fetch: an eyeball POST reaches the Node provider's fetch() and its Response rides back out", async () => {
  const ctx = freshCtx("caplivehttp");
  const device = new HttpDevice();
  await session().authenticate().projects.get(ctx).provide("itx.ws-device", device);

  const res = await fetch(expressionUrl(ctx, "itx.ws-device", "http"), {
    method: "POST",
    body: "ping",
  });
  expect(res.status).toBe(201);
  expect(await res.text()).toBe("pong-from-node-provider");
  expect(res.headers.get("x-device")).toBe("node-live-cap");
  expect(device.saw).toEqual([`POST /expression?context=${ctx}&itx=itx.ws-device body=ping`]);
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

test("lent stub WebSocket fetch: a plain eyeball WebSocket opens (101), echoes, and closes through the Node provider", async () => {
  const ctx = freshCtx("caplivews");
  await session().authenticate().projects.get(ctx).provide("itx.ws-device", new WsDevice());
  // Sanity: the rule still answers plain HTTP (so the assertions below are about the UPGRADE).
  const plain = await fetch(expressionUrl(ctx, "itx.ws-device", "http"));
  expect(await plain.text()).toBe("http-fallback");

  const ws = await wsRoundTrip(expressionUrl(ctx, "itx.ws-device", "ws"), "hello-device");
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("device-echo:hello-device");
  expect(ws.closeCode).toBe(1000);
});

// The workerd-provider half of the same lane is pinned in __workers-tests__/ws-fetch-live-101
// .test.ts (the dedicated fetch-upgrade leg; the DO mints the eyeball pair natively). A tunnel
// (`iterate tunnel bla 3000`) is this same lent stub proxying to localhost — the same three hops.

test("/expression refuses to re-enter itself: `itx=itx.fetch` (an expression fetching its own lane, the same query every hop) answers 508 after a few hops, never loops", async () => {
  const ctx = freshCtx("lane-reentry");
  const response = await fetch(expressionUrl(ctx, "itx.fetch"), {
    signal: AbortSignal.timeout(8000),
  });
  expect(response.status).toBe(508);
  expect(await response.text()).toMatch(/re-entered itself/);
});

test("a hop count the platform never wrote (an app spelling `NaN` to defeat the budget) is over budget on arrival: 508, never a loop", async () => {
  const response = await fetch(expressionUrl(freshCtx("lane-nan-hops"), "itx.whoami"), {
    headers: { "x-itx-expression-hops": "NaN" },
    signal: AbortSignal.timeout(8000),
  });
  expect(response.status).toBe(508);
  expect(await response.text()).toContain('"NaN"');
});

test("deleted routes fall through to the control plane's 404 — /call, /ws and /cap answer Not found, a WebSocket upgrade to /ws gets no 101", async () => {
  // The fetch door is /expression and nothing else: the old /call, /ws and /cap routes are gone and
  // land on the in-process control plane's catch-all (a plain 404 — never a 500), and an upgrade
  // attempt at /ws is refused (no 101).
  for (const path of ["/call?path=itx.whoami", "/ws", "/cap?context=prj_x&cap=itx.whoami"]) {
    const res = await fetch(workerUrl(path));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Not found");
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

/** Send a Request through a fresh context's egress terminal, with test query/headers. (WHATWG URL
 *  serialization keeps `{{`/`}}` literal in the query — verified — so a URL token arrives at the
 *  door byte-identical.) The Response rides back over capnweb. */
const egress = (query: string, headers?: Record<string, string>): Promise<Response> =>
  openItx(freshCtx("egress")).fetch(
    new Request(`https://egress.invalid/hunt?probe=1${query}`, { headers }),
  );

test("a missing project secret in a HEADER is a loud 502 naming the header and the token", async () => {
  const res = await egress("", { "x-hunt-auth": "Bearer {{secret:project:GHOST}}" });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain("{{secret:project:GHOST}}"); // the token is named to US, not the destination
  expect(body).toContain('header "x-hunt-auth"'); // …and WHERE it sat, so the caller can fix it
});

test("a missing project secret in the URL query is a loud 502 naming the URL — checked FIRST, before the headers", async () => {
  const res = await egress("&access_token={{secret:project:GHOST}}", {
    "x-hunt-auth": "{{secret:project:GHOST}}",
  });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain("{{secret:project:GHOST}}");
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
