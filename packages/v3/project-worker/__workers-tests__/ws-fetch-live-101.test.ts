// __workers-tests__/ws-fetch-live-101.test.ts — THE PLATFORM QUESTION, answered by running: does
// OUR lane forward a GENUINE 101 from a LIVE capability? YES — via the dedicated fetch-upgrade leg.
//
// The harness twin (__tests__/failing-ws-fetch-capability.test.ts) pinned that Node providers die
// at FABRICATION (no WebSocketPair; undici rejects status 101) — so the platform half needed a
// workerd-side provider, and THIS lane runs inside workerd. The provider lives here, parked over a
// real capnweb session; a real eyeball dials the /cap fetch door. Every hop is production-shaped:
//
//   eyeball SELF.fetch /cap → worker sets x-itx-cap → the DO's capability fetch lane →
//   the mount at `itx.wsdev` (pure data: target `itx.rpcStubs.get('itx.wsdev')`, the registry
//   holding the parked provider) → fetch/fetch-capabilities.ts: the DO asks the paged-in
//   invoker to dial (an RPC call that EXECUTES in the relay's session context; its return is the
//   honest ack), the relay dials the provider's fetch() over capnweb and opens ONE dedicated
//   fetch-upgrade leg back into the DO, the DO mints the eyeball's WebSocketPair natively, and
//   frames forward RAW between the two DO-side sockets. The stub pager stays a PAGER.
//
// WHY forwarded frames and not a passthrough (all dead ends measured 2026-08-31): workerd's JS RPC cannot
// serialize a webSocket-bearing Response (DataCloneError at the relay→DO return — same verdict
// when the capnweb stub itself is LOANED to the DO and dotted-called), a loopback ctx.exports
// entrypoint cannot touch the relay's capnweb session ("Cannot perform I/O on behalf of a
// different request" — I/O pins to its creating context), and proxying the socket as RPC streams
// pins the DO non-hibernatable for the socket's lifetime (evictDurableObject times out on "active
// references"). capnweb 0.12.0 carries the provider's 101 to the relay (socket-as-streams); the
// dedicated upgrade leg carries its frames the rest of the way, hibernatably.
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
async function openSession(): Promise<any> {
  const res = await SELF.fetch(`https://test.local/api`, {
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

/** Provide a fresh LiveSite over a live capnweb session at `itx.wsdev` — the ONE door. */
async function mountLiveSite(ctx: string): Promise<LiveSite> {
  const itx = await (await openSession()).authenticate().projects.get(ctx);
  const site = new LiveSite();
  await itx.provide("itx.wsdev", site);
  return site;
}

const capUrl = (ctx: string) => `https://test.local/cap?context=${ctx}&cap=itx.wsdev`;

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

// ─────────────────── the platform question proper — GREEN via the fetch-upgrade lane ───────────────────

// Was VERIFIED BROKEN (a DataCloneError on the RPC return leg) until the fetch-upgrade lane
// landed; now the regression pin for the whole path: genuine 101, frames BOTH ways through every
// hop (eyeball ⇄ DO pair ⇄ upgrade leg ⇄ relay ⇄ capnweb ⇄ provider pair), clean close. Also caught on
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
