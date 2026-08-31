// __tests__/failing-ws-fetch-capability.test.ts — BUG HUNT: does the hibernatable
// LIVE-CAPABILITY lane work for WEBSOCKET FETCH? A capnweb client provides a fetch-shaped live
// capability; a PLAIN Node WebSocket eyeball dials the fetch lane
// (`ws://<host>/cap?ctx=<ctx>&cap=itx.ws-device`). The test is LAYERED so the failure point is
// NAMED, not smeared:
//   1. baseline — the SAME /cap WebSocket flow against a LOADED-WORKER capability (the
//      prove_crisp1 case, kv-seeded source): proves the door itself.
//   2. live-capability HTTP fetch (non-upgrade): a real eyeball Request rides DO → Workers RPC →
//      relay → capnweb → Node provider, and the provider's Response rides all the way back out.
//   3. the UPGRADE case through the live capability — the platform question.
//   4. test.todo for what would make the platform half provable if Node fabrication is the
//      only blocker.
// Every test asserts CORRECT behavior; `test.fails` marks behavior VERIFIED BROKEN by running
// (BUG/EXPECTED/ACTUAL blocks inline). Run:
//   pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-ws-fetch-capability.test.ts

import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_wsfetch${RUN}_${name}`;

let harness: ProjectHarness;
// Client-side handles retained for the file's lifetime (a GC'd provision would tear a mount
// down mid-test); the harness disposes its sessions at stop().
const keep: unknown[] = [];
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

/** A raw HTTP/1.1 upgrade probe via node:http (undici's fetch strips Connection/Upgrade — the
 *  forbidden headers — so THIS is the only Node way to read the non-101 answer's status+body,
 *  which is where the fetch lane writes its error text). */
function rawUpgradeProbe(
  path: string,
  timeoutMs = 10_000,
): Promise<{ status?: number; body: string; upgraded: boolean; error?: string }> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: harness.url.hostname,
      port: harness.url.port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          "base64",
        ),
        "Sec-WebSocket-Version": "13",
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ body: "", upgraded: false, error: `probe timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body, upgraded: false });
      });
    });
    req.on("upgrade", (res, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: res.statusCode, body: "", upgraded: true });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      resolve({ body: "", upgraded: false, error: String(e) });
    });
    req.end();
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
  await itx.provide({
    path: "itx.site",
    target: "itx.load(\"itx.kv.get('src/site.js')\").getEntrypoint()",
  });

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
// fetch lane → capability table → rpcStubs.get alias → Workers RPC invoker → relay → capnweb
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
  const key = crypto.randomUUID();
  keep.push(await itxA.rpcStubs.provide(device, { key }));
  await itxA.provide({ path: "itx.ws-device", target: `itx.rpcStubs.get('${key}')` });

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

// ─────────────────────── 3. LIVE CAPABILITY, WebSocket UPGRADE — the platform question ───────────────────────

/** The upgrade-answering provider, instrumented: every observation is recorded so the failing
 *  hop is NAMED by data, not guessed. It attempts the workerd fabrication spelling faithfully
 *  and records each Node blocker it hits. */
class WsDevice extends RpcTarget {
  observations: string[] = [];
  async fetch(request: Request) {
    const upgrade = String(request?.headers?.get?.("upgrade") ?? "");
    this.observations.push(`fetch invoked: ${request.method} upgrade=${JSON.stringify(upgrade)}`);
    if (upgrade.toLowerCase() !== "websocket") return new Response("http-fallback");
    // The workerd spelling, attempted honestly in Node:
    const Pair = (globalThis as { WebSocketPair?: new () => Record<0 | 1, unknown> }).WebSocketPair;
    if (!Pair) this.observations.push("blocker: WebSocketPair is undefined in Node");
    try {
      new Response(null, { status: 101 });
      this.observations.push("101 Response constructed (unexpected in Node)");
    } catch (e) {
      this.observations.push(`blocker: ${String(e)}`);
    }
    if (Pair) {
      const pair = new Pair();
      const server = pair[1] as {
        accept(): void;
        addEventListener(t: string, cb: (e: { data: unknown }) => void): void;
        send(d: unknown): void;
      };
      server.accept();
      server.addEventListener("message", (e) => server.send(`device-echo:${e.data}`));
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    throw new Error(
      `ws-device provider cannot fabricate a 101 in Node: ${this.observations.join(" | ")}`,
    );
  }
}

test("upgrade REQUEST forwarding: the eyeball's ws upgrade reaches the Node provider through every hop, and the provider's error rides back out as the non-101 answer", async () => {
  const ctx = c("livewsprobe");
  const provider = harness.session(ctx);
  const itxA = await provider.authenticate().get();
  const device = new WsDevice();
  const key = crypto.randomUUID();
  keep.push(await itxA.rpcStubs.provide(device, { key }));
  await itxA.provide({ path: "itx.ws-device", target: `itx.rpcStubs.get('${key}')` });
  // Sanity: the mount answers plain HTTP (so everything below is about the UPGRADE, not the mount).
  const plain = await fetch(capUrl(ctx, "itx.ws-device", "http"));
  expect(await plain.text()).toBe("http-fallback");

  // The raw HTTP/1.1 upgrade dial (node:http — undici fetch strips the forbidden
  // Connection/Upgrade headers, so this is the only Node way to read the non-101 answer).
  const probe = await rawUpgradeProbe(`/cap?ctx=${ctx}&cap=${encodeURIComponent("itx.ws-device")}`);
  await new Promise((r) => setTimeout(r, 300));
  console.log("[wsfetch] raw upgrade probe:", JSON.stringify(probe).slice(0, 400));
  console.log("[wsfetch] provider observations:", JSON.stringify(device.observations));

  // POSITIVE PIN — request forwarding is NOT the blocker: the upgrade Request crossed eyeball →
  // /cap → DO fetch lane → capability table → rpcStubs alias → Workers RPC invoker → relay →
  // capnweb → the NODE provider, Upgrade header intact.
  expect(device.observations).toContain('fetch invoked: GET upgrade="websocket"');
  // The provider cannot fabricate a 101 in Node — BOTH blockers, named by the runtime itself.
  expect(device.observations).toContain("blocker: WebSocketPair is undefined in Node");
  expect(device.observations.some((o) => o.includes("must be in the range of 200 to 599"))).toBe(
    true,
  );
  // And the provider's throw rides every hop BACK: the eyeball's answer is the fetch lane's 500
  // carrying the provider's own words (error propagation through the live lane works).
  expect(probe.upgraded).toBe(false);
  expect(probe.status).toBe(500);
  expect(probe.body).toContain("ws-device provider cannot fabricate a 101 in Node");
});

// BUG: a fetch-shaped LIVE capability cannot answer a WebSocket upgrade when its provider runs
//   in Node — the failing hop is PROVIDER-SIDE FABRICATION, the very end of the lane: Node has
//   no WebSocketPair, and undici's Response rejects status 101 ('init["status"] must be in the
//   range of 200 to 599') and silently drops a `webSocket` init property. The platform carried
//   the upgrade Request all the way to the provider and would have carried its answer back (both
//   pinned by the passing forwarding test above) — but no conforming answer can exist in Node.
// EXPECTED: parity with the loaded-worker case (prove_crisp1 in production): the eyeball's
//   plain WebSocket opens (101), echoes, closes cleanly.
// ACTUAL: the fetch lane answers 500 (the provider's throw), so the eyeball's WebSocket never
//   opens — undici reports "Received network error or non-101 status code.", close code 1002.
//   Whether OUR lane would forward a GENUINE 101 (capnweb serializing a webSocket-bearing
//   Response, relay → Workers RPC → DO → eyeball) is PROVEN GREEN in workerd — the fetch-upgrade
//   lane (ws-fetch-live-101.test.ts); only Node-side FABRICATION remains impossible.
// WHY IT MATTERS: "clients are always connected" bridges are Node processes; a device that
//   wants to OFFER a WebSocket endpoint (itx.ws-device) as a live capability simply cannot,
//   today — every WS-fetch capability must be workerd-side loaded code, which the harness lane
//   can't even run (the baseline bug above).
test.fails("live capability WebSocket fetch: a plain eyeball WebSocket opens (101), echoes, and closes through the Node provider", async () => {
  const ctx = c("livews");
  const provider = harness.session(ctx);
  const itxA = await provider.authenticate().get();
  const device = new WsDevice();
  const key = crypto.randomUUID();
  keep.push(await itxA.rpcStubs.provide(device, { key }));
  await itxA.provide({ path: "itx.ws-device", target: `itx.rpcStubs.get('${key}')` });
  // THE CORRECT BEHAVIOR: the eyeball's WebSocket opens, echoes, closes.
  const ws = await wsRoundTrip(capUrl(ctx, "itx.ws-device", "ws"), "hello-device");
  console.log("[wsfetch] ws round trip:", JSON.stringify(ws));
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("device-echo:hello-device");
  expect(ws.closeCode).toBe(1000);
});

// ─────────────────────── 4. what WOULD make the platform half provable ───────────────────────

// The platform question proper — does OUR lane forward a GENUINE 101 from a LIVE capability — is
// ANSWERED GREEN in __workers-tests__/ws-fetch-live-101.test.ts: the dedicated fetch-upgrade leg (the DO
// mints the eyeball pair natively, frames tunnel over the stub pager) carries a workerd provider's
// genuine 101 + echo + close through every hop. Only provider-side fabrication in NODE stays
// impossible (the test.fails above).
