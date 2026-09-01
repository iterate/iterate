// dynamic-live-ws.e2e.test.ts — DYNAMIC WORKER ⇄ DYNAMIC WORKER over a LIVE fetch capability,
// WebSocket included. Provider worker A (loaded via itx.load) PROVIDES a live RpcTarget whose
// fetch() upgrades WebSockets; consumer worker B fetches it through its own env.ITX binding — a
// real Fetcher (the ItxEntrypoint loopback) — with the x-itx-cap header, riding the DO's fetch
// lane. Every hop is native Workers RPC / native fetch; no capnweb client anywhere.

import { expect, test } from "vitest";
import { bareItx, freshCtx } from "./support/client.ts";

const PROVIDER_SRC = `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
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
    // Held on globalThis so nothing GC-revokes DURING this invocation; note it does NOT keep the
    // capability alive past the invocation (see the lifetime test below).
    globalThis.__keep = { itx, provided, device };
    if (mode === "self-plain") {
      const res = await this.env.ITX.fetch(
        new Request("https://cap.internal/", { headers: { "x-itx-cap": "itx.wsdyn" } }),
      );
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    }
    if (mode === "self-ws") {
      const res = await this.env.ITX.fetch(
        new Request("https://cap.internal/", {
          headers: { "x-itx-cap": "itx.wsdyn", Upgrade: "websocket" },
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
}`;

const CONSUMER_SRC = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Consumer extends WorkerEntrypoint {
  async run(kind) {
    if (kind === "plain") {
      const res = await this.env.ITX.fetch(
        new Request("https://cap.internal/", { headers: { "x-itx-cap": "itx.wsdyn" } }),
      );
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    }
    const res = await this.env.ITX.fetch(
      new Request("https://cap.internal/", {
        headers: { "x-itx-cap": "itx.wsdyn", Upgrade: "websocket" },
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
}`;

async function seedBoth(itx: ReturnType<typeof bareItx>): Promise<void> {
  await itx.invokeCapability(["itx", "kv", ["put", "src/provider.js", PROVIDER_SRC]]);
  await itx.invokeCapability(["itx", "kv", ["put", "src/consumer.js", CONSUMER_SRC]]);
}
const runProvider = (itx: ReturnType<typeof bareItx>, mode: string): Promise<unknown> =>
  itx.invokeCapability(`itx.load("itx.kv.get('src/provider.js')").getEntrypoint().run('${mode}')`);

test("within the provider's invocation: a dyn-provided live capability serves PLAIN fetch", async () => {
  const itx = bareItx(freshCtx("dynliveself"));
  await seedBoth(itx);
  const out = (await runProvider(itx, "self-plain")) as { status: number; body: string };
  // dyn-worker → env.ITX (Fetcher) → DO fetch lane → live stub invoke(['fetch']) → back into the
  // SAME dyn-worker's device — a socketless Response crosses every native hop.
  expect(out).toEqual({ status: 200, body: "dyn live site" });
});

// BUG (VERIFIED, measured 2026-08-31): the fetch-upgrade dial assumes a hop that can carry
// a webSocket-bearing Response. For a CAPNWEB provider (browser/Node/workerd client over /api)
// that hop tunnels sockets (the fork's socket-as-streams) — ws-fetch-live-101 is green. For a
// NATIVE provider (a dynamic worker providing over env.ITX.get(), where the retained stub is a
// plain jsrpc stub), the dial's `provider.fetch(upgrade)` return leg IS Workers RPC — and the
// provider's genuine 101 dies there:
//   500 "DataCloneError: Could not serialize object of type WebSocket" (at dialLiveCapabilityFetch)
// EXPECTED: parity with capnweb providers — 101 + echo. Fix directions in the session notes: the
// symmetric dial-back (the provider opens its OWN upgrade leg via its env.ITX Fetcher — it HAS
// one) or an SDK-side provider shim; the plain-fetch half (test above) already works everywhere.
test.fails("within the provider's invocation: WEBSOCKET fetch of the dyn-provided live capability", async () => {
  const itx = bareItx(freshCtx("dynlivewsself"));
  await seedBoth(itx);
  const out = (await runProvider(itx, "self-ws")) as {
    status: number;
    echo?: string;
    body?: string;
  };
  expect(out).toEqual({ status: 101, echo: "dyn-echo:hi-self" });
});

// BUG-OR-CONTRACT (VERIFIED, re-measured 2026-09-01): a dyn-provided live STUB DIES WITH THE
// PROVIDING INVOCATION. The IterateContext scope a dynamic worker gets from env.ITX.get() lives in the
// ItxEntrypoint loopback's request context; the parking + pager socket holding the provider
// transport die when that context ends (the run() call chain completing), so the DO drops the
// stub from its `itx.rpcStubs` registry. The MOUNT at itx.wsdyn is pure data and STAYS (nothing
// auto-revokes a mount because a socket dropped) — worker B resolves it and hits the offline
// registry entry, which the fetch lane reports as
//   500 "fetch lane error: Error: live capability \"itx.wsdyn\" is offline" (CONNECTION_OFFLINE)
// — mounted-but-offline, not default-deny; measured here as `expected 500 to be 200`.
// (holding the itx stub on the provider's globalThis does NOT keep the remote context alive).
// EXPECTED (the scenario this pins): provide in one invocation, fetch from another worker later.
// Whether the fix is a detached-provider primitive (session-shaped parking for dyn workers) or a
// doctrine ruling ("live caps are invocation-scoped; detached fetch-shaped things must be MOUNTED
// code — itx.load(...).getEntrypoint() / a named durable facet, both of which already serve WS")
// is an owner call — see the session notes.
test.fails("ACROSS invocations: worker B fetches the capability A provided (the detached-provider question)", async () => {
  const itx = bareItx(freshCtx("dynlivex"));
  await seedBoth(itx);
  expect(await runProvider(itx, "provide")).toBe("provided");
  const out = (await itx.invokeCapability(
    `itx.load("itx.kv.get('src/consumer.js')").getEntrypoint().run('plain')`,
  )) as { status: number; body: string };
  expect(out.status).toBe(200);
  expect(out.body).toBe("dyn live site");
});
