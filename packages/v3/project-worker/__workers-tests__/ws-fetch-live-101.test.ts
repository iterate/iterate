// __workers-tests__/ws-fetch-live-101.test.ts — THE PLATFORM QUESTION, answered by running: does
// OUR lane forward a GENUINE 101 from a LIVE capability?
//
// The harness twin (__tests__/failing-ws-fetch-capability.test.ts) pinned that the upgrade
// Request reaches a live provider through every hop and that PROVIDER-SIDE FABRICATION is where
// Node dies (no WebSocketPair; undici rejects status 101) — so the platform half stayed UNPROVEN
// there. A provider that CAN mint a webSocket-bearing Response needs workerd — and THIS lane runs
// inside workerd: the test-runner isolate has WebSocketPair and the 101 Response natively. So the
// provider lives HERE, parked over a real capnweb session (the failing-alarm-quiesce openSession
// pattern), and a real eyeball dials the /cap fetch door. Every hop is production-shaped:
//
//   eyeball SELF.fetch /cap → worker sets x-itx-cap → DO #fetchCapLane → capability table →
//   `itx.rpcStubs.get('<key>')` alias → retained-stub invoker (Workers RPC, DO ↔ relay) →
//   capnweb (the /api WebSocket) → THIS isolate's provider.fetch() — and the provider's answer
//   rides every hop back out to the eyeball.
//
// THE ANSWER (measured 2026-08-31, wrangler-pinned workerd + capnweb 0.12.0): NO — but the
// blocker MOVED. capnweb 0.12.0 grew webSocket-in-Response serialization (the socket crosses as
// a pair of streams; the receiving side re-mints a WebSocketPair), so the SUSPECTED blocker —
// capnweb — is NOT the failing hop: the provider is invoked with the Upgrade header intact and
// fabricates its 101 (both pinned below). The death is the NATIVE Workers RPC leg — the relay
// returning the webSocket-bearing Response to the DO over RetainedCallbackInvoker.invoke():
//   DataCloneError: Could not serialize object of type "WebSocket". This type does not support
//   serialization.   (at HibernatableRpcStubManager.invoke)
// workerd's JS RPC has no WebSocket serialization, and unlike a fetch chain there is no native
// 101 passthrough on a plain RPC method return. Fixing it means teaching the relay↔DO leg the
// same streams trick capnweb uses (or routing the fetch lane's live-stub hop over a real fetch).
// Run:
//   pnpm exec vitest run --project workers __workers-tests__/ws-fetch-live-101.test.ts

import { SELF } from "cloudflare:test";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, expect, test } from "vitest";

/** The live provider: a fetch-shaped capability that CAN fabricate a 101 (we are in workerd).
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

// ── session plumbing — the failing-alarm-quiesce openSession pattern, verbatim ──

const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
const sessions: unknown[] = [];
// Client-side ProvidedStub handles retained for the file's lifetime (a GC'd provision would
// close the transport and auto-revoke the mount mid-test).
const keep: unknown[] = [];
async function openSession(ctx: string): Promise<any> {
  const res = await SELF.fetch(`https://test.local/api?ctx=${ctx}`, {
    headers: { Upgrade: "websocket" },
  });
  if (!res.webSocket) throw new Error(`expected a 101 with a WebSocket, got ${res.status}`);
  res.webSocket.accept();
  const session = newWebSocketRpcSession(res.webSocket as unknown as WebSocket);
  sessions.push(session);
  return session as any;
}
afterAll(async () => {
  // Let any fire-and-forget cleanup drain before the pool worker's RPC is torn down.
  await new Promise((r) => setTimeout(r, 50));
  for (const s of sessions) {
    try {
      if (DISPOSE) (s as Record<symbol, () => void>)[DISPOSE]?.();
    } catch {
      /* already broken */
    }
  }
});

/** Provide a fresh LiveSite over a live capnweb session and alias it at `itx.wsdev`. */
async function mountLiveSite(ctx: string): Promise<LiveSite> {
  const itx = await (await openSession(ctx)).get();
  const site = new LiveSite();
  const key = crypto.randomUUID();
  keep.push(await itx.rpcStubs.provide(site, { key }));
  await itx.provide({ path: "itx.wsdev", target: `itx.rpcStubs.get('${key}')` });
  return site;
}

const capUrl = (ctx: string) => `https://test.local/cap?ctx=${ctx}&cap=itx.wsdev`;

// ─────────────── the passing halves: plain fetch works; the failing hop is NAMED ───────────────

test("plain fetch through a LIVE capability: the eyeball's GET reaches the workerd provider and its 200 rides back out", async () => {
  const ctx = "prj_ws101_plain";
  const site = await mountLiveSite(ctx);
  const page = await SELF.fetch(capUrl(ctx));
  const body = await page.text();
  console.log("[ws101] plain GET:", page.status, JSON.stringify(body).slice(0, 400));
  expect(page.status).toBe(200);
  expect(body).toBe("live site");
  expect(site.observations).toContain('fetch invoked: GET upgrade=""');
});

test("upgrade probe: the provider IS reached and fabricates a GENUINE 101 — the answer dies on the Workers RPC leg (DataCloneError), NOT in capnweb", async () => {
  // The POSITIVE pin of the platform answer. Everything up to and INCLUDING provider-side
  // fabrication works — so the harness twin's Node blocker is gone in workerd, and capnweb
  // 0.12.0's webSocket-in-Response serialization is not what fails. What the eyeball gets is
  // the fetch lane's 500 quoting workerd's own native-RPC refusal, stack-anchored at the
  // retained-stub invoker await — the relay→DO Workers RPC return leg.
  const ctx = "prj_ws101_probe";
  const site = await mountLiveSite(ctx);
  const res = await SELF.fetch(capUrl(ctx), { headers: { Upgrade: "websocket" } });
  const body = await res.text();
  console.log("[ws101] upgrade probe:", res.status, JSON.stringify(body).slice(0, 600));
  console.log("[ws101] provider observations:", JSON.stringify(site.observations));

  // The upgrade Request crossed every hop INTO the provider, Upgrade header intact…
  expect(site.observations).toContain('fetch invoked: GET upgrade="websocket"');
  // …and the provider minted a conforming answer (the thing Node could never do).
  expect(site.observations).toContain("fabricated a genuine 101 with a webSocket");
  // The failing hop, named by the runtime itself: workerd JS RPC cannot serialize a WebSocket.
  expect(res.status).toBe(500);
  expect(body).toContain('DataCloneError: Could not serialize object of type "WebSocket"');
  expect(body).toContain("HibernatableRpcStubManager.invoke"); // the relay→DO Workers RPC leg
});

// ─────────────────────── the platform question proper — VERIFIED BROKEN ───────────────────────

// BUG: a fetch-shaped LIVE capability cannot answer a WebSocket upgrade even when its provider
//   CAN fabricate a genuine 101 (a workerd-side capnweb client). The failing hop is the NATIVE
//   Workers RPC leg of the live-stub lane — the relay handing the webSocket-bearing Response
//   back to the DO over RetainedCallbackInvoker.invoke():
//     DataCloneError: Could not serialize object of type "WebSocket". This type does not
//     support serialization.   (thrown awaiting retained.invoker.invoke, hibernatable-rpc-stub.ts)
//   capnweb 0.12.0 DID carry the 101 across the session (webSocket-as-streams — the probe above
//   pins provider-side success), so of the lane's two serializing hops only the workerd-native
//   one remains broken.
// EXPECTED: parity with the loaded-worker baseline (harness twin, prove_crisp1): 101, echo,
//   clean close — a live device could OFFER a WebSocket endpoint as a capability.
// ACTUAL: the fetch lane answers 500 carrying the DataCloneError above; the eyeball never gets
//   a webSocket.
// WHY IT MATTERS: WS-fetch capabilities remain loaded-worker-only. A fix must teach the
//   relay↔DO leg what capnweb 0.12.0 taught the session (socket-as-streams), or route the
//   live-stub fetch hop over a real fetch() so workerd's native 101 passthrough applies.
test.fails("live capability WebSocket fetch: the eyeball's upgrade gets the provider's GENUINE 101, echoes, and closes cleanly", async () => {
  const ctx = "prj_ws101_correct";
  await mountLiveSite(ctx);
  // THE CORRECT BEHAVIOR: a genuine 101 bearing a usable WebSocket…
  const res = await SELF.fetch(capUrl(ctx), { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
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
