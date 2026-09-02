// __workers-tests__/hibernation-at-scale.test.ts — THE HIBERNATION PROPERTY AT SCALE, inside
// workerd (the workers lane — vitest.config.ts's `workers` project):
//
//   Hundreds of clients connect into ONE stream (each providing a live capnweb capability at its
//   own mount path, with a hibernatable stub pager WebSocket), the stream DO EVICTS — losing every
//   in-memory paged-in stub — and on wake it can STILL call every client's capability:
//   page → paged-in stub → invoke (context/hibernatable-rpc-stub.ts).
//
// The property made deterministic: a live deployment waits minutes for Cloudflare's own
// eviction; here cloudflare:test's evictDurableObject() forces the
// same instance teardown on demand, with hibernatable WebSockets PRESERVED (webSockets:
// "hibernate" is its default — the exact production semantic).
//
// EVICTION MECHANISM (the first that works, per the lane's mandate — alternatives documented):
//   (a) runInDurableObject(stub, (_i, state) => state.abort()) — REJECTED, MEASURED: the call
//       itself rejects with the abort reason (abort kills the very request running the
//       callback), and the hibernatable pager WebSockets DIE with the instance — a probe showed
//       /state stubs 1 → 0 across the abort. That is client-death semantics, not hibernation:
//       it destroys the exact property under test.
//   (b) evictDurableObject(stub) from cloudflare:test — USED: purpose-built graceful eviction
//       ("tearing down its instance to reset in-memory state while preserving durable storage.
//       By default, hibernatable WebSockets are hibernated rather than closed"), i.e. exactly
//       workerd's idle eviction. MEASURED CAVEAT: on a WARM DO (paged-in RetainedCallbackInvoker
//       stubs retained) it times out after 30s with "Timed out waiting to evict Durable Object:
//       it still has active references" — which is FAITHFUL to production: a DO holding live RPC
//       stubs is pinned non-hibernatable (workerd#6800, the reason the quiesce alarm exists). So
//       each eviction here reproduces the production sequence first: quiesce (dispose stubs) →
//       evict — see quiesceLikeProduction().
//   (c) runDurableObjectAlarm() to fire the 60s quiesce — NOT VIABLE as the eviction ITSELF: the
//       alarm body re-arms without quiescing unless 60 REAL seconds of idle have passed (alarm()
//       checks Date.now() - lastActivity >= 60_000), and even then it only disposes paged-in
//       stubs — the weaker assertion, subsumed by (b). It IS however the production-shaped way
//       to reach dormancy on demand once Date alone is faked forward 61s (fake timers scoped to
//       Date only — the alarm scheduler and sockets stay real), which is how (b)'s precondition
//       is met above.

import { evictDurableObject } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { Echo, openSession, quiesce, stub } from "./support.ts";

const CTX = "prj_hibscale";
const CLIENTS = 200;

/** The DO-only transport facts (transportState(): the whole in-memory socket census — physical
 *  truths, never event-derivable; `itx.rpcStubs.list()` is the edge half, PRESENCE = the
 *  keys with a transport right now. This workers lane holds the raw DO stub, so it speaks
 *  the Workers-RPC verb directly). */
type TransportState = {
  stubs: number;
  pagedIn: number;
  pagesPending: number;
  dormant: boolean;
};
async function state(): Promise<TransportState> {
  return (await stub(CTX).transportState()) as unknown as TransportState;
}
/** Incarnation (the hibernation tell) — the core reduce's fold of the stream/woken wake record
 *  (`itx.facets.get('core').snapshot()`; present from the constructor's wake on — every
 *  incarnation writes one before any door opens). */
async function incarnationNow(): Promise<number> {
  const snap = (await stub(CTX).invoke("itx.facets.get('core').snapshot()")) as {
    state: { incarnation?: number };
  };
  return snap.state.incarnation ?? 0;
}

let callerItx: any; // a SEPARATE caller session (no capabilities of its own)

/** The production 60s idle quiesce on demand (support.ts's `quiesce`), then the two facts this
 *  file leans on: every paged-in stub disposed, the DO dormant — evictDurableObject's de-facto
 *  precondition (see mechanism note (b) in the header: evicting a warm DO times out on "active
 *  references", exactly the production #6800 pin). */
async function quiesceLikeProduction(): Promise<void> {
  await quiesce(CTX);
  const s = await state();
  expect(s.pagedIn).toBe(0); // the quiesce disposed every paged-in stub
  expect(s.dormant).toBe(true);
}

beforeAll(async () => {
  // ONE client session carrying all 200 stubs (capnweb multiplexes; each itx.provide(path, stub)
  // parks its own Echo relay-side in the `itx.rpcStubs` registry, opens its own stub pager
  // WebSocket into the DO, and mounts the pure-data target `itx.rpcStubs.get('itx.cN')` — the
  // registry is presence, the table is the mount; event volume is fine).
  const clientItx = await (await openSession()).authenticate().projects.get(CTX);
  const BATCH = 25; // concurrent provides per wave — enough parallelism without a thundering herd
  for (let base = 0; base < CLIENTS; base += BATCH) {
    await Promise.all(
      Array.from({ length: Math.min(BATCH, CLIENTS - base) }, (_, k) => {
        const i = base + k;
        return clientItx.provide(`itx.c${i}`, new Echo(i));
      }),
    );
  }
  callerItx = await (await openSession()).authenticate().projects.get(CTX);
}, 120_000);

test("SCALE ATTACH: 200 clients park 200 stubs, the DO stays dormant, spot invokes hit the right client", async () => {
  const s = await state();
  expect(s.stubs).toBeGreaterThanOrEqual(CLIENTS);
  // Dormant-ish: attaching NEVER pages — 200 connected clients leave zero stubs in memory.
  expect(s.pagedIn).toBe(0);
  expect(s.dormant).toBe(true);

  // Spot-invoke 5 random clients through the SEPARATE caller — per-client answers, no crosstalk.
  const picks = new Set<number>();
  while (picks.size < 5) picks.add(Math.floor(Math.random() * CLIENTS));
  for (const i of picks) {
    const out = await callerItx.invokeCapability(`itx.c${i}.echo('x${i}')`);
    expect(out).toBe(`echo-${i}:x${i}`);
  }

  const after = await state();
  expect(after.pagedIn).toBeGreaterThanOrEqual(5); // the spot invokes each paid one page
});

test("EVICT THEN WAKE: eviction drops every in-memory stub; a call pages the relay back in and answers", async () => {
  const before = await state();
  const beforeIncarnation = await incarnationNow();
  expect(before.pagedIn).toBeGreaterThanOrEqual(5); // warm from the previous test

  // The production sequence: quiesce (dispose the paged-in stubs — without this the eviction
  // times out on "active references", the #6800 pin), THEN evict: instance torn down, storage
  // kept, hibernatable sockets hibernated.
  await quiesceLikeProduction();
  await evictDurableObject(stub(CTX));

  const evicted = await state(); // read-only probe — wakes a FRESH instance
  expect(evicted.pagedIn).toBe(0); // every paged-in stub died with the instance
  expect(evicted.pagesPending).toBe(0);
  expect(evicted.dormant).toBe(true);
  // THE property: the hibernatable pager sockets (and their attachments — the whole routing
  // identity) survived the eviction.
  expect(evicted.stubs).toBeGreaterThanOrEqual(CLIENTS);

  // The wake path, several clients: page → fresh RetainedCallbackInvoker → invoke.
  for (const i of [3, 77, 141]) {
    const out = await callerItx.invokeCapability(`itx.c${i}.echo('wake${i}')`);
    expect(out).toBe(`echo-${i}:wake${i}`);
  }
  const paged = await state();
  expect(paged.pagedIn).toBeGreaterThanOrEqual(3); // the pages grew the paged-in set back

  // A REAL eviction shows as incarnation growth on the next durable write (Stream.touch
  // bumps once per incarnation-that-writes; reads never bump).
  await callerItx.provide("itx.hello", "itx.kv");
  expect(await incarnationNow()).toBeGreaterThan(beforeIncarnation);
});

test("SCALE WAKE: after another eviction, a fan-out reaches ALL 200 clients", async () => {
  await quiesceLikeProduction(); // the previous test left 3+ stubs paged in — same #6800 dance
  await evictDurableObject(stub(CTX));
  const evicted = await state();
  expect(evicted.pagedIn).toBe(0);

  const t0 = Date.now();
  // fan-out = PRESENCE (`itx.rpcStubs.list()` — the registry keys with a transport; the mount
  // path IS each key, so every key is callable dotted) + map over the paths (no built-in
  // `each`); the caller owns the allSettled. The list itself is a pin: the attachments
  // rehydrated from the hibernated pager sockets — exactly the fleet, nothing dropped.
  const paths = (await callerItx.invokeCapability("itx.rpcStubs.list()")) as string[];
  expect(paths.length).toBe(CLIENTS);
  const answers = (
    await Promise.all(
      paths.map((path) => callerItx.invokeCapability(`${path}.echo('hi')`).catch(() => undefined)),
    )
  ).filter((v): v is string => v !== undefined);
  const wallMs = Date.now() - t0;
  console.log(
    `SCALE WAKE: ${answers.length}/${CLIENTS} answers in ${wallMs}ms (cold fan-out: every answer paid page → stub → invoke)`,
  );

  expect(answers.length).toBe(CLIENTS);
  const got = new Set(answers);
  for (let i = 0; i < CLIENTS; i++) expect(got.has(`echo-${i}:hi`)).toBe(true);
  expect(wallMs).toBeLessThan(60_000); // generous — the bound documents "it completes", not a perf SLO

  const after = await state();
  expect(after.pagedIn).toBeGreaterThanOrEqual(CLIENTS); // the whole fleet paged back in
});
