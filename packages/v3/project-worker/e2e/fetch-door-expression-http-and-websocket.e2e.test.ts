// fetch-door-expression-http-and-websocket.e2e.test.ts — the ONE fetch door (/expression): a GET and a
// WebSocket upgrade reach whatever the named itx expression's fetch() is — a LOADED WORKER behind a
// rewrite rule (the seeded site, workerd-native WebSocketPair + 101) and a LENT RPC STUB provided by a
// plain NODE capnweb client (the device/ESP32 shape: `new WebSocketPair()` +
// `upgradeWebSocketResponse(pair[0])`, capnweb's universal pair + sender-side answer). Layered so a
// regression names its hop: the loaded-worker door first, then the lent stub's plain HTTP fetch
// (eyeball → /expression → DO fetch lane → rewrite rule → the rpcStubs registry → relay → capnweb →
// the Node provider and back), then its upgrade.

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
import { seedSources } from "./support/sources.ts";

test("/expression serves a LOADED WORKER behind a rewrite rule: GET → 200 HTML, WebSocket upgrade → 101 echo, clean close", async () => {
  const ctx = freshCtx("capcode");
  // A rule whose target is a stateless dynamic worker (its .fetch serves /expression) — the target
  // is an itx EXPRESSION (load(src).getEntrypoint()), same as every other rule.
  const itx = openItx(ctx);
  await seedSources(itx, ["site"]);
  await itx.provide("itx.site", "itx.load(\"itx.kv.get('src/site.js')\").getEntrypoint()");

  const page = await fetch(expressionUrl(ctx, "itx.site", "http"));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("dynamic web capability");

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

/** A fetch-shaped live rpc stub that records what it saw and answers a distinctive Response. */
class HttpDevice extends RpcTarget {
  saw: string[] = [];
  async fetch(request: Request) {
    this.saw.push(
      `${request.method} ${new URL(request.url).pathname} body=${await request.text()}`,
    );
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
  expect(device.saw).toEqual(["POST /expression body=ping"]);
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
// .test.ts (the dedicated fetch-upgrade leg; the DO mints the eyeball pair natively). The tunnel
// (proxy-to-localhost) shape of this lent stub is fetch-door-tunnel-to-localhost.e2e.test.ts.

test("deleted routes fall through to the help text — /call, /ws and /cap answer text, a WebSocket upgrade to /ws gets no 101", async () => {
  // The fetch door is /expression and nothing else: the old /call, /ws and /cap routes are gone and
  // land on the worker's one-line help, and an upgrade attempt at /ws is refused (no 101).
  for (const path of ["/call?path=itx.whoami", "/ws", "/cap?context=prj_x&cap=itx.whoami"]) {
    const res = await fetch(workerUrl(path));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("project-worker —");
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
