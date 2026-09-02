// __workers-tests__/do-doors.test.ts — the IterateContextDurableObject's Workers-RPC doors,
// pinned at zero distance (the pool lane is the only one that can BOTH call the DO verbs raw —
// no capnweb edge folding the returns away — AND inspect the DO's own storage via
// runInDurableObject). Three pins live here:
//
//   • the VIRGIN-PROBE alarm blind spot: a probe (`itx.facets.get('core').snapshot()`) must not
//     arm the quiet clock on a never-touched ctx — the storage-lazy doctrine's one blind spot,
//     which only storage.getAlarm() can see (the harness lane pins incarnation/tables but cannot
//     read the alarm);
//   • the provide door's SHAPE: it canonicalizes the path on its own (a Workers-RPC caller
//     bypasses the edge canonicalizer), and a mount is `{ path, target, providedAtOffset }` and
//     NOTHING else — no lane, no delivery, no processor field (capability-table 5.0.0: HOW a
//     target is served is never written on a mount; the subscriptions layer decides by
//     evaluating its own target, subscription-delivery.ts);
//   • revokeCapability's `void` return on both spellings (`{ providedAtOffset }` | `{ path }`) — a
//     mount and a parked stub are SEPARATE things: revoking a live mount pops the row and never
//     touches a transport. The stub stays in `itx.rpcStubs` until the session that parked it
//     closes it.

import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, expect, test } from "vitest";
import { canonicalName } from "../src/context/durable-object-names.ts";
import { print, type Expression } from "../src/context/expression.ts";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";

const stub = (ctx: string) =>
  (
    env as unknown as { CONTEXT: DurableObjectNamespace<IterateContextDurableObject> }
  ).CONTEXT.getByName(canonicalName(ctx));

/** One capability-table row as the snapshot serializes it (the reduced state's `target` is the
 *  parsed Expression — `print` it to compare against the string the door was given). */
type MountRow = { path: string[]; target: Expression; providedAtOffset: number };
const mountsOf = async (ctx: string): Promise<MountRow[]> =>
  (
    (await stub(ctx).invoke("itx.facets.get('capability-table').snapshot()")) as {
      state: { mounts: MountRow[] };
    }
  ).state.mounts;

// ── a real capnweb session, for the one pin that needs a PHYSICAL stub in play (the
// hibernation-at-scale openSession pattern) ──
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
/** The live value under test — a method receiver, so the registry reach is the documented
 *  pipelinable spelling `itx.rpcStubs.get('<key>').ping()`. */
class Alive extends RpcTarget {
  ping(): string {
    return "alive";
  }
}
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50));
  for (const s of sessions) {
    try {
      (s as Partial<Disposable>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
  }
});

test("a core-snapshot probe on a VIRGIN ctx arms NO alarm and mints NO storage — the first real append arms it", async () => {
  await runInDurableObject(stub("prj_doors_virginprobe"), async (instance, state) => {
    // The probe rides invoke() → #noteActivity; on a never-touched context it must not write the
    // quiet-clock alarm (a durable write + a billed wake on a ctx that was only probed — the
    // storage-lazy doctrine's blind spot the arc review caught).
    const snap = (await instance.invoke("itx.facets.get('core').snapshot()")) as {
      state?: { incarnation?: number };
    };
    expect(snap.state?.incarnation ?? 0).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull(); // THE pin: no quiet-clock arm
    const tables = state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((r) => String(r.name));
    expect(tables).not.toContain("events");
    expect(state.storage.kv.get("incarnation")).toBeUndefined();
    // …and the guard is ONLY for virgin streams: the first real write arms the quiet clock, so
    // the quiesce machinery still runs for every context that has anything to quiesce.
    await instance.append({ type: "mark" });
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});

test("provideCapability canonicalizes the path itself — and a mount is `{ path, target, providedAtOffset }`, nothing else", async () => {
  // A Workers-RPC caller bypasses the edge canonicalizer, so the DO door must hold on its own: a
  // non-canonical spelling (leading whitespace) lands the CANONICAL path with the target verbatim.
  // And the row carries no third kind of field — the old per-mount `lane` stamp went with the
  // lanes: nothing about HOW a target is served is on a mount (a live stub's mount is pure data
  // naming the `itx.rpcStubs` registry; a subscription is its own layer's event, not a mount).
  const ctx = "prj_doors_canonical";
  await stub(ctx).provideCapability({
    path: " itx.aliased.ghost",
    target: "itx.rpcStubs.get('itx.aliased.ghost')",
  });
  const row = (await mountsOf(ctx)).find((m) => m.path.join(".") === "itx.aliased.ghost");
  expect(row).toBeDefined(); // stored CANONICAL — the one-canonicalizer rule
  expect(print(row!.target)).toBe("itx.rpcStubs.get('itx.aliased.ghost')"); // the target, verbatim
  expect(Object.keys(row!).sort()).toEqual(["path", "providedAtOffset", "target"]); // and nothing else
});

test("revokeCapability resolves to void on both spellings and never touches a transport — the stub outlives its mount", async () => {
  const ctx = "prj_doors_revokedlive";
  const s = stub(ctx);
  // A PHYSICAL stub: a capnweb session parks a live fn under `itx.livecap` (its pager socket is
  // one transport in the DO's census) and mounts the pure-data target naming it.
  const itx = await (await openSession()).authenticate().projects.get(ctx);
  const live = (await itx.provide("itx.livecap", new Alive())) as { providedAtOffset: number };
  const alias = await s.provideCapability({ path: "itx.aliascap", target: "itx.whoami" });
  expect(await s.invoke("itx.livecap.ping()")).toBe("alive");
  const before = (await s.transportState()) as { stubs: number };
  expect(before.stubs).toBe(1);

  // By OFFSET — the pipelined provide+revoke spelling. The mount pops; the transport is NOT
  // touched: the census is unchanged, the registry still lists the key, and only the MOUNT is
  // gone (default-deny at the path — NO_CAPABILITY_MATCH, not offline).
  expect(await s.revokeCapability({ providedAtOffset: live.providedAtOffset })).toBeUndefined();
  expect(((await s.transportState()) as { stubs: number }).stubs).toBe(before.stubs);
  expect(await s.invoke("itx.rpcStubs.list()")).toEqual(["itx.livecap"]);
  // (The denied call rides the capnweb session, not the raw DO stub: a rejecting DO call through
  // the vitest-plugin's RPC bridge is echoed by workerd as an "Uncaught (in promise)" line even
  // when caught; over /api the CODED error simply crosses the hop.)
  let denied: { code?: string } | undefined;
  try {
    await itx.invokeCapability("itx.livecap.ping()");
  } catch (e) {
    denied = e as { code?: string };
  }
  expect(denied?.code).toBe("NO_CAPABILITY_MATCH");
  expect((await mountsOf(ctx)).some((m) => m.path.join(".") === "itx.livecap")).toBe(false);
  // …and the parked stub is still reachable THROUGH THE REGISTRY, mount or no mount.
  expect(await s.invoke("itx.rpcStubs.get('itx.livecap').ping()")).toBe("alive");

  // By PATH — an EXPRESSION mount: same void return, nothing physical to touch.
  expect(await s.revokeCapability({ path: "itx.aliascap" })).toBeUndefined();
  expect((await mountsOf(ctx)).some((m) => m.path.join(".") === "itx.aliascap")).toBe(false);
  // Idempotent re-revoke of an already-gone row: still void, still silent.
  expect(await s.revokeCapability({ providedAtOffset: alias.providedAtOffset })).toBeUndefined();
  expect(((await s.transportState()) as { stubs: number }).stubs).toBe(before.stubs);
});
