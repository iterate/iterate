// __workers-tests__/ws-fetch-live-101.test.ts — THE PLATFORM QUESTION, answered by running: does
// OUR lane forward a GENUINE 101 from a LENT RPC STUB? YES — via the dedicated fetch-upgrade leg.
//
// The harness-lane twin pinned that Node providers die
// at FABRICATION (no WebSocketPair; undici rejects status 101) — so the platform half needed a
// workerd-side provider, and THIS lane runs inside workerd. The provider lives here, lent over a
// real capnweb session; a real eyeball dials the /expression fetch door. Every hop is
// production-shaped:
//
//   eyeball SELF.fetch /expression → worker sets x-itx-expression → the DO's itx-expression fetch
//   lane → the rewrite rule at `itx.wsdev` (pure data: target `itx.rpcStubs.get('itx.wsdev')`, the
//   registry naming the lent provider) → fetch/rpc-stub-fetch.ts: the DO asks the borrowed
//   stub to dial (an RPC call that EXECUTES in the relay's session context; its return is the
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
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { openSession } from "./support.ts";

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

/** Provide a fresh LiveSite over a live capnweb session under `itx.wsdev`, with the rewrite rule
 *  at the same spelling — the ONE door. */
async function provideLiveSite(ctx: string): Promise<LiveSite> {
  const itx = await (await openSession()).authenticate().projects.get(ctx);
  const site = new LiveSite();
  await itx.provide("itx.wsdev", { stub: site, rewrite: "itx.wsdev" });
  return site;
}

/** The edge's plain-HTTP fetch door: `?context=` names the context, `?itx=` the itx expression. */
const expressionUrl = (ctx: string) => `https://test.local/expression?context=${ctx}&itx=itx.wsdev`;

// ─────────────── the passing halves: plain fetch works; the failing hop is NAMED ───────────────

test("plain fetch through a LENT RPC STUB: the eyeball's GET reaches the workerd provider and its 200 rides back out", async () => {
  const ctx = "prj_ws101_plain";
  const site = await provideLiveSite(ctx);
  const page = await SELF.fetch(expressionUrl(ctx));
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
test("lent-stub WebSocket fetch: the eyeball's upgrade gets the provider's GENUINE 101, echoes, and closes cleanly", async () => {
  const ctx = "prj_ws101_correct";
  const site = await provideLiveSite(ctx);
  // THE CORRECT BEHAVIOR: a genuine 101 bearing a usable WebSocket…
  const res = await SELF.fetch(expressionUrl(ctx), { headers: { Upgrade: "websocket" } });
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
