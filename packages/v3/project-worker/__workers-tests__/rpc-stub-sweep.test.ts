// __workers-tests__/rpc-stub-sweep.test.ts — THE ATTACH-RESERVATION LAZY SWEEP, inside workerd
// (the pool-workers lane — the only lane that can speak the DO's relay-facing Workers-RPC verbs
// directly: `rpcStubAttach` without ever opening the pager is exactly the shape a client-side rig
// can never spell, which is why __tests__/failing-connections.test.ts carried it as a test.todo.
// This file replaces that todo).
//
// Target surface: RpcStubDirectory #pending + #sweepPending (src/rpc-stub-directory.ts). An attach
// reservation whose stub pager WebSocket never arrives — a relay that died mid-handshake — is
// dropped LAZILY after ATTACH_PENDING_TTL_MS = 10s: the sweep runs on the next attach()/fetch(),
// NEVER on a timer (a pending timer would pin the DO out of hibernation). The pending map is
// invisible to transportState() on purpose, so the sweep is observed through its ONE external
// consequence, the 409 door: a pager upgrade carrying a swept transportId 409s ("attach first"),
// telling a relay that outlived the reservation to re-attach.
//
// Clock rig: the failing-alarm-quiesce pattern — fake Date ONLY (+11s > the 10s TTL; sockets, the
// alarm scheduler and real timers stay real), so the DO's Date.now() stamps and cutoffs move while
// every RPC still completes.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, expect, test, vi } from "vitest";
import { canonicalName } from "../src/core/durable-object-names.ts";
import { STUB_PAGER_WEBSOCKET_HEADER } from "../src/core/hibernatable-rpc-stub.ts";
import type { IterateContextDurableObject } from "../src/stream-durable-object.ts";

const stub = (ctx: string) =>
  (
    env as unknown as { CONTEXT: DurableObjectNamespace<IterateContextDurableObject> }
  ).CONTEXT.getByName(canonicalName(ctx));

/** Open a pager upgrade straight at the DO's fetch door (what openStubPagerWebSocket does
 *  relay-side) — the raw request lets us carry a SWEPT transportId, which no live relay would. */
const openPager = (ctx: string, transportId: string) =>
  stub(ctx).fetch("https://stub-pager.internal/", {
    headers: { Upgrade: "websocket", [STUB_PAGER_WEBSOCKET_HEADER]: transportId },
  });

// ── the happy-path rig (hibernation-at-scale's, minimized): a capnweb session over SELF /api ──

class Echo extends RpcTarget {
  readonly #i: number;
  constructor(i: number) {
    super();
    this.#i = i;
  }
  echo(s: string): string {
    return `echo-${this.#i}:${s}`;
  }
}
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
const sessions: unknown[] = [];
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
  // Let any fire-and-forget page/close cleanup drain before the pool worker's RPC is torn down —
  // otherwise a still-pending resolve surfaces as a (harmless) EnvironmentTeardownError.
  await new Promise((r) => setTimeout(r, 50));
  for (const s of sessions) {
    try {
      if (DISPOSE) (s as Record<symbol, () => void>)[DISPOSE]?.();
    } catch {
      /* already broken */
    }
  }
});

test("ABANDONED ATTACH IS LAZILY SWEPT: 11s later the next attach drops it — the swept pager 409s ('attach first'), a fresh one proceeds", async () => {
  const ctx = "prj_sweep";
  const s = stub(ctx);

  // A relay that dies mid-handshake: reserve a transport for itx.k1, NEVER open its pager.
  const { transportId: abandoned } = await s.rpcStubAttach({ path: "itx.k1" });

  // +11s of fake Date, then a second attach — its #sweepPending sees k1's reservation past the
  // 10s TTL and drops it. (k2's own atMs is stamped at the faked future instant, so it sits safely
  // inside the TTL window of every later real-time sweep.)
  let fresh: string;
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 11_000);
    fresh = (await s.rpcStubAttach({ path: "itx.k2" })).transportId;
  } finally {
    vi.useRealTimers();
  }

  // The 409 door observes the sweep: the swept transportId is unknown now — a relay holding it
  // must re-attach. (Were the sweep broken, this upgrade would 101 and attach a zombie k1.)
  const swept = await openPager(ctx, abandoned);
  expect(swept.status).toBe(409);
  expect(await swept.text()).toContain("attach first");

  // The FRESH un-swept reservation proceeds: its pager upgrades and the itx.k2 stub attaches.
  const ok = await openPager(ctx, fresh);
  expect(ok.status).toBe(101);
  ok.webSocket!.accept();
  const state = (await s.transportState()) as unknown as { stubs: number };
  expect(state.stubs).toBe(1); // itx.k2 attached; the swept itx.k1 reservation left NOTHING behind
  ok.webSocket!.close(1000, "test done");
});

test("HAPPY PATH UNTOUCHED: attach + prompt pager upgrade within the TTL — provide over /api, a caller's invoke answers", async () => {
  // The production sequence the sweep must never bite: itx.provide(path, stub) makes the relay
  // attach and open its pager IMMEDIATELY (well inside the 10s TTL), so the stub parks and a
  // separate caller reaches it through the mount path: page → paged-in stub → invoke.
  const ctx = "prj_sweep_happy";
  const clientItx = await (await openSession(ctx)).get();
  await clientItx.provide("itx.live", new Echo(7));
  const caller = await (await openSession(ctx)).get();
  const out = await caller.invokeCapability("itx.live.echo('hi')");
  expect(out).toBe("echo-7:hi");
});
