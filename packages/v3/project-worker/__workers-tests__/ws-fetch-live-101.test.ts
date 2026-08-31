// __workers-tests__/ws-fetch-live-101.test.ts — THE PLATFORM QUESTION, answered by running: does
// OUR lane forward a GENUINE 101 from a LIVE capability? YES — via the pager WebSocket bridge.
//
// The harness twin (__tests__/failing-ws-fetch-capability.test.ts) pinned that Node providers die
// at FABRICATION (no WebSocketPair; undici rejects status 101) — so the platform half needed a
// workerd-side provider, and THIS lane runs inside workerd. The provider lives here, parked over a
// real capnweb session; a real eyeball dials the /cap fetch door. Every hop is production-shaped:
//
//   eyeball SELF.fetch /cap → worker sets x-itx-cap → DO #fetchCapLane → capability table →
//   `itx.rpcStubs.get('<key>')` alias → the WS BRIDGE (hibernatable-rpc-stub.ts): the DO mints
//   the eyeball's WebSocketPair NATIVELY (a 101 on the fetch channel), sends ws-open down the
//   stub pager WebSocket, and the relay — in the capnweb session's own request context — dials
//   the provider's fetch(); frames then tunnel over the pager both ways.
//
// WHY a bridge and not a passthrough (both dead ends measured 2026-08-31): workerd's JS RPC
// cannot serialize a webSocket-bearing Response (DataCloneError at the relay→DO invoke() return),
// and a loopback ctx.exports entrypoint cannot touch the relay's capnweb session either ("Cannot
// perform I/O on behalf of a different request" — I/O objects pin to their creating context). The
// pager socket is the ONE channel already connecting the DO to the session's context. capnweb
// 0.12.0 carries the provider's webSocket-bearing Response to the relay (socket-as-streams);
// the bridge carries its frames the rest of the way.
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

// ─────────────────── the platform question proper — GREEN via the pager bridge ───────────────────

// Was VERIFIED BROKEN (the DataCloneError above, pinned here as a test.fails) until the bridge
// landed; now the regression pin for the whole path: genuine 101, frames BOTH ways through every
// hop (eyeball ⇄ DO pair ⇄ pager ⇄ relay ⇄ capnweb ⇄ provider pair), clean close. Also caught on
// the way: the pager keepalive literal must be DISTINCTIVE — setWebSocketAutoResponse is DO-wide,
// so a plain "ping"/"pong" pair hijacked any eyeball frame equal to "ping".
test("live capability WebSocket fetch: the eyeball's upgrade gets the provider's GENUINE 101, echoes, and closes cleanly", async () => {
  const ctx = "prj_ws101_correct";
  const site = await mountLiveSite(ctx);
  // THE CORRECT BEHAVIOR: a genuine 101 bearing a usable WebSocket…
  const res = await SELF.fetch(capUrl(ctx), { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
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
