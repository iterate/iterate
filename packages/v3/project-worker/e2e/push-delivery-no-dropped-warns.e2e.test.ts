// push-delivery-no-dropped-warns.e2e.test.ts — the three pins that read the WORKER'S CONSOLE: the
// delivery loop emits `delivery.push.dropped` for a push that fails with anything but
// RPC_STUB_OFFLINE and `subscription-delivery.dispatch` for a dispatch failure; these tests assert
// those lines do NOT appear — a property no client-side observation can stand in for (a facet's
// cold catch-up would heal a dropped push before a snapshot could tell). Logs are worker-global, so
// this file boots its OWN worker (support/log-harness.ts) and runs its tests sequentially; every
// other e2e file speaks to the shared worker through support/client.ts.

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  append,
  collector,
  freshCtx,
  presence,
  processorNames,
  readAll,
  readHead,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";
import { startLoggedWorker, type LoggedWorker } from "./support/log-harness.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

let worker: LoggedWorker;
beforeAll(async () => {
  worker = await startLoggedWorker();
}, 120_000);
afterAll(async () => {
  await worker?.stop();
});

const countMatches = (text: string, re: RegExp) => (text.match(re) ?? []).length;
/** Every delivery-side error line the loop can emit: a dropped push, a dispatch issue. */
const DELIVERY_ERRORS = /delivery\.push\.dropped|subscription-delivery\.dispatch|NO_FACET/g;
const deliveryErrors = () => countMatches(worker.logs(), DELIVERY_ERRORS);
const tallySnapshot = async (itx: any): Promise<any> =>
  itx.invoke("itx.facets.get('tally').snapshot()");
/** Expected tally counts = groupBy(type) over the DURABLE log (tally consumes "*", durable only). */
const durableCountsByType = (events: any[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
};

test("enabling a processor on a quiet stream is clean — zero delivery errors, its first delivered batch is its own enablement commit", async () => {
  // Identity is `ctx.props`, minted at materialization — there is no configure window in which the
  // enablement commit's drive could reach a facet that does not know itself yet.
  const itx = await worker.itx(freshCtx("quietenable"));
  await sleep(400); // let stragglers flush before the baseline
  const before = deliveryErrors();
  await enableFixtureProcessor(itx, "tally");
  const head = await readHead(itx);
  const snap: any = await until("tally at head", async () => {
    const s: any = await tallySnapshot(itx);
    return s.offset >= head && s;
  });
  // the enablement commit itself was reduced (tally consumes "*")
  expect(snap.state.counts["events.iterate.com/stream/subscription-configured"]).toBe(1);
  await sleep(400);
  expect(deliveryErrors() - before).toBe(0);
});

test("disable mid-drive: appends survive, no ongoing error storm, re-enable rebuilds an exact reduce", async () => {
  const itx = await worker.itx(freshCtx("middrive"));
  await enableFixtureProcessor(itx, "tally");
  await append(itx, { type: "warm" }); // one delivery so the facet exists
  const headWarm = await readHead(itx);
  await until("tally warm", async () => ((await tallySnapshot(itx)) as any).offset >= headWarm);

  // the burst + the disable, racing (in-flight pushes vs facet delete)
  const burst = Array.from({ length: 10 }, (_, i) =>
    append(itx, { type: "burst", payload: { i } }),
  );
  const disabled = itx.disableProcessor("tally");
  await Promise.all([...burst, disabled]); // appends must all survive the disable
  expect(await processorNames(itx)).not.toContain("tally");

  // post-disable traffic must not keep erroring into the dead facet: in-flight pushes may log a
  // bounded burst at the disable moment, but NOTHING new may appear afterwards
  await sleep(500);
  const beforeErrors = deliveryErrors();
  for (let i = 0; i < 10; i++) await append(itx, { type: "post", payload: { i } });
  await sleep(700);
  expect(deliveryErrors()).toBe(beforeErrors); // no NEW delivery errors

  // re-enable: a CLEAN reduce — exact counts over the whole durable log, nothing doubled, nothing
  // inherited from the dead lineage (disable deleted the facet, storage included).
  await enableFixtureProcessor(itx, "tally");
  const head = await readHead(itx);
  const expected = durableCountsByType(await readAll(itx));
  const snap: any = await until("re-enabled tally reduced the whole log", async () => {
    const s: any = await tallySnapshot(itx).catch(() => undefined);
    return s && s.offset >= head && s;
  });
  expect(snap.state.counts).toEqual(expected);
  expect(snap.state.counts.burst).toBe(10);
  expect(snap.state.counts.post).toBe(10);
});

/** A WebSocket client whose raw TCP socket we can STOP READING (the browser/undici WebSocket hides
 *  it): the `ws` package, resolved through wrangler's dependency tree because this package keeps no
 *  direct dep on it. Pausing `_socket` closes the TCP window, so every server→client send buffers
 *  inside workerd — the client-controllable choke point of the delivery transport. capnweb interops
 *  with a `ws` WebSocket directly (its transport needs only binaryType/readyState/
 *  addEventListener/send, and `ws` speaks all four). */
type StallableWebSocket = {
  _socket: { pause(): void; resume(): void };
  readyState: number;
  send(data: string): void;
  close(): void;
  /** Hard TCP destroy — no close handshake (which a paused peer could never read anyway). */
  terminate(): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
};
function stallableWebSocket(url: string): StallableWebSocket {
  const req = createRequire(import.meta.url);
  const wranglerDir = dirname(req.resolve("wrangler/package.json"));
  const { WebSocket: WsWebSocket } = req(req.resolve("ws", { paths: [wranglerDir] }));
  return new WsWebSocket(url) as StallableWebSocket;
}

test("MEASURED FINDING: a push subscriber that stops reading mid-flood is NOT closed by local workerd (≥60MiB buffers silently) — but a real socket close drops its stub instantly and removes its ROW (a live subscription is session-scoped)", async () => {
  // The loop's design comment (subscription-delivery.ts): a push is fire-and-forget; the socket
  // buffer is the only queue. This ran that claim to ground against local workerd: 60.0MiB of
  // payload flooded into a TCP-paused subscriber produced NO close, NO delivery.push.dropped warn,
  // NO RPC_STUB_OFFLINE — workerd buffers the outgoing WebSocket without any local limit we could
  // reach (the buffering policy is workerd's, not this codebase's). What IS ours (close →
  // onRpcBroken → pager close → the DO drops the transport → `itx.rpcStubs.list()` stops listing the
  // key; and capnweb disposes the session's SubscriptionHandle → the ROW is removed) is proven live
  // below. RESIDUAL: real edge sockets have real buffer limits, so the overflow-close half may hold
  // in production; this pins LOCAL workerd only. If the still-present assertion ever fails, workerd
  // grew a send-buffer limit — flip this pin to assert the overflow-close instead.
  const ctx = freshCtx("overflow");
  const itx = await worker.itx(ctx); // connection A: setup, the flood, and observation
  // Connection B — THE VICTIM: its own client socket, because the callback stub it lent lives in
  // that socket's relay session; the socket's death must become the stub's death.
  const wsB = stallableWebSocket(`ws://${worker.url.host}/api`);
  const sessionB: any = newWebSocketRpcSession(wsB as any);
  const victim = sessionB.authenticate().projects.get(ctx);
  const c = collector();
  await victim.subscribe({ name: "victim", consumes: ["flood"], target: c.fn });
  // one probe proves the lane end-to-end BEFORE the stall
  await append(itx, { type: "flood", ephemeral: true, payload: { probe: true } });
  await until("probe delivered over the victim socket", () => c.invocations.length >= 1);
  // the victim's row is a PUSH row (pure data — target `itx.rpcStubs.get('subscription:victim')`,
  // no cursor); whether that stub is ONLINE is the registry's fact, read separately
  const victimRow = { name: "victim", target: "itx.rpcStubs.get('subscription:victim')" };
  const before = await subscriptions(itx);
  expect(before).toContainEqual(expect.objectContaining(victimRow));
  expect(before.find((r) => r.name === "victim").cursor).toBeUndefined();
  const victimOnline = async () => (await presence(itx)).includes("subscription:victim");
  expect(await victimOnline()).toBe(true);
  const droppedWarns = () => countMatches(worker.logs(), /delivery\.push\.dropped/g);
  const droppedBefore = droppedWarns(); // logs are worker-global — assert the DELTA, not zero

  // THE STALL: stop reading the victim's TCP socket. The kernel recv buffer fills, the TCP window
  // closes, and workerd's sends for this socket can only buffer.
  wsB._socket.pause();

  // THE FLOOD: ephemeral events (memory-only server-side) with chunky payloads, ~0.5MiB per append
  // (two 256KiB events — each hop's message stays under production's 1MiB WebSocket-message cap).
  // Bounded at 60MiB; bail the moment the stub drops from presence (it never did — see above).
  const chunk = "x".repeat(256 * 1024);
  let floodedBytes = 0;
  let stubDropped = false;
  for (let i = 0; i < 120 && !stubDropped; i++) {
    await append(
      itx,
      { type: "flood", ephemeral: true, payload: { i, chunk } },
      { type: "flood", ephemeral: true, payload: { i: i + 0.5, chunk } },
    );
    floodedBytes += 2 * chunk.length;
    stubDropped = !(await victimOnline());
  }
  // bounded negative wait: when a close DOES propagate, the drop lands in tens of ms (measured
  // below via the kill) — 1.5s is ample for an overflow-close triggered by the flood to surface.
  if (!stubDropped) {
    const tGrace = Date.now();
    while (Date.now() - tGrace < 1_500 && !stubDropped) {
      stubDropped = !(await victimOnline());
      if (!stubDropped) await sleep(150);
    }
  }
  const after = await subscriptions(itx);
  console.log(
    `overflow: flooded ${(floodedBytes / 1024 / 1024).toFixed(1)}MiB into a paused socket; ` +
      `stubDropped=${stubDropped}; dropped-warn delta=${droppedWarns() - droppedBefore}`,
  );
  // THE FINDING, pinned: the full 60MiB went in and NOTHING happened — no close, no stub drop, no
  // dropped-delivery warn. workerd absorbed it all in memory.
  expect(floodedBytes).toBe(120 * 2 * 256 * 1024);
  expect(stubDropped).toBe(false);
  expect(after).toContainEqual(expect.objectContaining(victimRow));
  expect(await victimOnline()).toBe(true);
  expect(droppedWarns() - droppedBefore).toBe(0);

  // THE CHAIN IS SOUND: hard-kill the stalled socket (RST — no close handshake a paused reader
  // could never read) and the stub drop fires end-to-end: relay onRpcBroken → pager close → the
  // DO drops the transport → presence stops listing the key. Measured 10–30ms; the until bound
  // is generous, not a latency pin.
  const tKill = Date.now();
  wsB.terminate();
  await until(
    "stub gone from presence after the socket died",
    async () => !(await victimOnline()),
    15_000,
  );
  console.log(`socket kill → stub dropped from presence in ${Date.now() - tKill}ms`);
  // THE ROW IS SESSION-SCOPED: the dead session's SubscriptionHandle is disposed by capnweb, and its
  // dispose appends `subscription-configured { name, target: null }` — the row leaves the table
  // without anyone calling anything. The producer is unaffected: an append still commits, nothing
  // is pushed to a dead stub, and no dropped-delivery warn is logged.
  await until("the victim's row removed with its session", async () =>
    (await subscriptions(itx)).every((r) => r.name !== "victim"),
  );
  await append(itx, { type: "flood", ephemeral: true, payload: { afterKill: true } });
  await sleep(300);
  expect(droppedWarns() - droppedBefore).toBe(0);
  expect(await subscriptions(itx)).toEqual([]);
}, 55_000);
