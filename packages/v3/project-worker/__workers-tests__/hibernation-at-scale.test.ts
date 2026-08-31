// __workers-tests__/hibernation-at-scale.test.ts — THE HIBERNATION PROPERTY AT SCALE, inside
// workerd (the pool-workers lane; see vitest.workers.config.ts):
//
//   Hundreds of clients connect into ONE stream (each parking a live capnweb capability as an
//   ItxConnection with a hibernatable stub pager WebSocket), the stream DO EVICTS — losing every
//   in-memory paged-in stub — and on wake it can STILL call every client's capability:
//   page → paged-in stub → invoke (core/hibernatable-rpc-stub.ts).
//
// This is proofs/prove_hibernate.mjs's property made deterministic: the live proof waits ~4min
// holds for Cloudflare's own eviction; here cloudflare:test's evictDurableObject() forces the
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

import { evictDurableObject, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { canonicalName } from "../src/core/durable-object-names.ts";
import type { StreamDurableObject } from "../src/stream-durable-object.ts";

const CTX = "prj_hibscale";
const CLIENTS = 200;

/** One connected client's live capability — the per-client tag proves no crosstalk. */
class EchoTarget extends RpcTarget {
  readonly #i: number;
  constructor(i: number) {
    super();
    this.#i = i;
  }
  echo(s: string): string {
    return `echo-${this.#i}:${s}`;
  }
}

/** /state through the worker's observability door (read-only — never mints storage). */
type StreamState = {
  incarnation: number;
  stubs: number;
  pagedIn: number;
  pagesPending: number;
  dormant: boolean;
};
async function state(): Promise<StreamState> {
  // Observability over the one door: the DO's hostState() method (the /state HTTP route is gone).
  return (await contextStub().hostState()) as unknown as StreamState;
}

const contextStub = () =>
  (env as unknown as { CONTEXT: DurableObjectNamespace<StreamDurableObject> }).CONTEXT.getByName(
    canonicalName(CTX),
  );

// capnweb sessions live for the whole file; dispose at teardown (the harness.ts lesson: sessions
// left open turn into unhandled-rejection noise).
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
const sessions: unknown[] = [];

/** Open a capnweb session to the worker over a WebSocket upgrade on SELF.fetch —
 *  newWebSocketRpcSession accepts the existing (accepted) socket per its typings. */
async function openSession(): Promise<any> {
  const res = await SELF.fetch(`https://test.local/api?ctx=${CTX}`, {
    headers: { Upgrade: "websocket" },
  });
  if (!res.webSocket) throw new Error(`expected a 101 with a WebSocket, got ${res.status}`);
  res.webSocket.accept();
  const session = newWebSocketRpcSession(res.webSocket as unknown as WebSocket);
  sessions.push(session);
  return session as any;
}

let callerItx: any; // a SEPARATE caller session (no capabilities of its own)

/** Reproduce the production 60s idle quiesce ON DEMAND: fake Date ONLY (+61s — sockets, alarm
 *  scheduler and timers stay real), fire the armed alarm (runDurableObjectAlarm runs a scheduled
 *  alarm immediately), restore real time. The alarm's quiesce branch disposes every paged-in
 *  RetainedCallbackInvoker stub, making the DO dormant — which is also evictDurableObject's
 *  de-facto precondition (see mechanism note (b) in the header: evicting a warm DO times out on
 *  "active references", exactly the production #6800 pin). */
async function quiesceLikeProduction(): Promise<void> {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 61_000);
    await runDurableObjectAlarm(contextStub());
  } finally {
    vi.useRealTimers();
  }
  const s = await state();
  expect(s.pagedIn).toBe(0); // the quiesce disposed every paged-in stub
  expect(s.dormant).toBe(true);
}

beforeAll(async () => {
  // ONE client session carrying all 200 stubs (capnweb multiplexes; each rpcStubs.provide() parks
  // its own EchoTarget relay-side and opens its own stub pager WebSocket into the DO).
  const clientItx = await (await openSession()).get();
  const BATCH = 25; // concurrent provides per wave — enough parallelism without a thundering herd
  for (let base = 0; base < CLIENTS; base += BATCH) {
    await Promise.all(
      Array.from({ length: Math.min(BATCH, CLIENTS - base) }, (_, k) => {
        const i = base + k;
        return clientItx.rpcStubs.provide(new EchoTarget(i), {
          key: `c${i}`,
          description: `scale client ${i}`,
        });
      }),
    );
  }
  callerItx = await (await openSession()).get();
}, 120_000);

afterAll(() => {
  for (const s of sessions) {
    try {
      if (DISPOSE) (s as Record<symbol, () => void>)[DISPOSE]?.();
    } catch {
      /* already broken */
    }
  }
});

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
    const out = await callerItx.invokeCapability(`itx.rpcStubs.get('c${i}').echo('x${i}')`);
    expect(out).toBe(`echo-${i}:x${i}`);
  }

  const after = await state();
  expect(after.pagedIn).toBeGreaterThanOrEqual(5); // the spot invokes each paid one page
});

test("EVICT THEN WAKE: eviction drops every in-memory stub; a call pages the relay back in and answers", async () => {
  const before = await state();
  expect(before.pagedIn).toBeGreaterThanOrEqual(5); // warm from the previous test

  // The production sequence: quiesce (dispose the paged-in stubs — without this the eviction
  // times out on "active references", the #6800 pin), THEN evict: instance torn down, storage
  // kept, hibernatable sockets hibernated.
  await quiesceLikeProduction();
  await evictDurableObject(contextStub());

  const evicted = await state(); // read-only probe — wakes a FRESH instance
  expect(evicted.pagedIn).toBe(0); // every paged-in stub died with the instance
  expect(evicted.pagesPending).toBe(0);
  expect(evicted.dormant).toBe(true);
  // THE property: the hibernatable pager sockets (and their attachments — the whole routing
  // identity) survived the eviction.
  expect(evicted.stubs).toBeGreaterThanOrEqual(CLIENTS);

  // The wake path, several clients: page → fresh RetainedCallbackInvoker → invoke.
  for (const i of [3, 77, 141]) {
    const out = await callerItx.invokeCapability(`itx.rpcStubs.get('c${i}').echo('wake${i}')`);
    expect(out).toBe(`echo-${i}:wake${i}`);
  }
  const paged = await state();
  expect(paged.pagedIn).toBeGreaterThanOrEqual(3); // the pages grew the paged-in set back

  // A REAL eviction shows as incarnation growth on the next durable write (StreamEventLog.touch
  // bumps once per incarnation-that-writes; reads never bump).
  await callerItx.provide({ path: "itx.hello", target: "itx.kv" });
  const bumped = await state();
  expect(bumped.incarnation).toBeGreaterThan(before.incarnation);
});

test("SCALE WAKE: after another eviction, a fan-out reaches ALL 200 clients", async () => {
  await quiesceLikeProduction(); // the previous test left 3+ stubs paged in — same #6800 dance
  await evictDurableObject(contextStub());
  const evicted = await state();
  expect(evicted.pagedIn).toBe(0);

  const t0 = Date.now();
  // fan-out = list() + map over get(key).echo (no built-in `each`); the caller owns the allSettled.
  const keys = ((await callerItx.invokeCapability("itx.rpcStubs.list()")) as { key: string }[]).map(
    (r) => r.key,
  );
  const answers = (
    await Promise.all(
      keys.map((k) =>
        callerItx.invokeCapability(`itx.rpcStubs.get('${k}').echo('hi')`).catch(() => undefined),
      ),
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
