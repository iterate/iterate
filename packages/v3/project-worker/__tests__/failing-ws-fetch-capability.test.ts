// __tests__/failing-ws-fetch-capability.test.ts — the LIVE-CAPABILITY lane serves WEBSOCKET
// FETCH from a NON-workerd provider (the device/ESP32 shape): a capnweb client on /api provides
// a fetch-shaped live capability whose fetch() answers upgrades with the blessed workerd idiom —
// `new WebSocketPair()` + `upgradeWebSocketResponse(pair[0])` (capnweb ≥0.12.2, the universal
// pair + sender-side answer; docs/capnweb-upgrade-answer.md). A plain Node eyeball dials the
// fetch lane (`ws://<host>/cap?ctx=<ctx>&cap=itx.ws-device`) and gets a real 101 + echo + clean
// close. LAYERED so a regression names its hop:
//   1. baseline — the SAME /cap WebSocket flow against a LOADED-WORKER capability: the door.
//   2. live-capability HTTP fetch (non-upgrade): eyeball Request → DO → relay → capnweb → Node
//      provider and back.
//   3. the UPGRADE through the live capability — formerly a test.fails (Node could not
//      fabricate the answer: no WebSocketPair, undici rejects 101), green since 0.12.2.
// Run:
//   pnpm exec vitest run --project harness __tests__/failing-ws-fetch-capability.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget, upgradeWebSocketResponse, WebSocketPair } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_wsfetch${RUN}_${name}`;

let harness: ProjectHarness;
// Live mounts ride their providing session (the harness disposes its sessions at stop()) — no
// client-side handle to retain: the mount path is the stub's identity.
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

const capUrl = (ctx: string, cap: string, scheme: "http" | "ws") =>
  `${scheme}://${harness.url.host}/cap?ctx=${ctx}&cap=${encodeURIComponent(cap)}`;

/** One full eyeball WebSocket round trip: open → send → first message → close. Never throws —
 *  the caller asserts on the outcome (so a test.fails failure is an EXPECT, not a stray). */
function wsRoundTrip(
  url: string,
  send: string,
  timeoutMs = 10_000,
): Promise<{ opened: boolean; echo?: string; closeCode?: number; error?: string }> {
  return new Promise((resolve) => {
    const out: { opened: boolean; echo?: string; closeCode?: number; error?: string } = {
      opened: false,
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ ...out, error: `constructor threw: ${String(e)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ...out, error: out.error ?? `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    ws.addEventListener("open", () => {
      out.opened = true;
      ws.send(send);
    });
    ws.addEventListener("message", (ev) => {
      out.echo = String((ev as MessageEvent).data);
      ws.close(1000, "done");
    });
    ws.addEventListener("error", (ev) => {
      out.error = String((ev as { message?: unknown }).message ?? "websocket error");
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      out.closeCode = (ev as CloseEvent).code;
      resolve(out);
    });
  });
}

// ─────────────────────────── 1. BASELINE: the /cap door against a LOADED worker ───────────────────────────
// The prove_crisp1 case, in the harness: the capability is workerd-side code (the Worker
// Loader), where WebSocketPair + 101 Responses are native. If THIS fails, the door is broken
// and the live-capability verdicts below say nothing.

const SITE_SOURCE = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Site extends WorkerEntrypoint {
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("baseline site", { headers: { "content-type": "text/plain" } });
  }
}`;

// WAS a test.fails: the loaded-worker lane was dead locally — workerd rejected the loader child's
// allow_irrevocable_stub_storage flag without --experimental, and wrangler exposed no passthrough.
// The wrangler 4.127 bump (workerd 1.20260815 accepts the flag) fixed it, and the surface it
// called (`itx.workers.get({source})`) has since been replaced by the Worker-Loader mirror
// (`itx.load(src).getEntrypoint()`). Now the GREEN baseline the live-capability verdicts below
// lean on — the same flow fetchdoor.e2e.test.ts pins in the e2e lane.
test("baseline: /cap serves HTTP and a 101 WebSocket echo from a LOADED-WORKER capability", async () => {
  const ctx = c("baseline");
  const itx = await harness.itx(ctx);
  await itx.invokeCapability(["itx", "kv", ["put", "src/site.js", SITE_SOURCE]]);
  await itx.provide("itx.site", "itx.load(\"itx.kv.get('src/site.js')\").getEntrypoint()");

  // HTTP through the door
  const page = await fetch(capUrl(ctx, "itx.site", "http"));
  const pageBody = await page.text();
  console.log("[wsfetch] baseline HTTP:", page.status, JSON.stringify(pageBody).slice(0, 800));
  expect(page.status).toBe(200);
  expect(pageBody).toBe("baseline site");

  // WebSocket through the door: 101, echo, clean close
  const ws = await wsRoundTrip(capUrl(ctx, "itx.site", "ws"), "hello-from-eyeball");
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("site-echo:hello-from-eyeball");
  expect(ws.closeCode).toBe(1000);
});

// ─────────────────────── 2. LIVE CAPABILITY, plain HTTP fetch (non-upgrade) ───────────────────────
// The Request is minted by a REAL eyeball (not a capnweb client): eyeball → worker /cap → DO
// fetch lane → capability table live row → Workers RPC invoker → relay → capnweb
// → the NODE provider's fetch(). Its Response rides every hop back out. (prove_rich pinned
// Request/Response over capnweb between two capnweb clients; this pins the EYEBALL-originated
// path in the harness.)

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

test("live capability HTTP fetch: an eyeball POST reaches the Node provider's fetch() and its Response rides back out", async () => {
  const ctx = c("livehttp");
  const provider = harness.session(ctx);
  const itxA = await provider.authenticate().get();
  const device = new HttpDevice();
  await itxA.provide("itx.ws-device", device);

  const res = await fetch(capUrl(ctx, "itx.ws-device", "http"), {
    method: "POST",
    body: "ping",
  });
  const body = await res.text();
  console.log(
    "[wsfetch] live-cap HTTP fetch:",
    res.status,
    JSON.stringify(body),
    JSON.stringify(device.saw),
  );
  expect(res.status).toBe(201);
  expect(body).toBe("pong-from-node-provider");
  expect(res.headers.get("x-device")).toBe("node-live-cap");
  expect(device.saw).toEqual(["POST /cap body=ping"]);
});

// ─────────────────────── 3. LIVE CAPABILITY, WebSocket UPGRADE — green since capnweb 0.12.2 ───────────────────────
// History: this was the platform's sharpest test.fails — the upgrade Request crossed every hop
// to the Node provider (pinned green) and the platform lane carried a genuine workerd 101 end
// to end (ws-fetch-live-101.test.ts), but a Node provider could not FABRICATE the answer: no
// WebSocketPair, and undici's Response rejects status 101. capnweb 0.12.2's universal
// WebSocketPair + upgradeWebSocketResponse close exactly that gap — the device below is the
// workerd fetch-handler idiom, verbatim, running in Node.

/** The device: a fetch-shaped live capability that upgrades WebSockets — the same source a
 *  workerd provider would ship. */
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

test("live capability WebSocket fetch: a plain eyeball WebSocket opens (101), echoes, and closes through the Node provider", async () => {
  const ctx = c("livews");
  const provider = harness.session(ctx);
  const itxA = await provider.authenticate().get();
  const device = new WsDevice();
  await itxA.provide("itx.ws-device", device);
  // Sanity: the mount still answers plain HTTP (so the assertions below are about the UPGRADE).
  const plain = await fetch(capUrl(ctx, "itx.ws-device", "http"));
  expect(await plain.text()).toBe("http-fallback");

  const ws = await wsRoundTrip(capUrl(ctx, "itx.ws-device", "ws"), "hello-device");
  console.log("[wsfetch] ws round trip:", JSON.stringify(ws));
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("device-echo:hello-device");
  expect(ws.closeCode).toBe(1000);
});

// The workerd-provider half of the same lane is pinned in __workers-tests__/ws-fetch-live-101
// .test.ts (the dedicated fetch-upgrade leg; the DO mints the eyeball pair natively). The tunnel
// (proxy-to-localhost) shape of this same capability is __tests__/failing-tunnel-proxy.test.ts.
