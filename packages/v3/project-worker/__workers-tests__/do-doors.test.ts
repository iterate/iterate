// __workers-tests__/do-doors.test.ts — the IterateContextDurableObject's Workers-RPC doors,
// pinned at zero distance (the workers lane is the only one that can BOTH call the DO verbs raw —
// no capnweb edge reducing the returns away — AND inspect the DO's own storage via
// runInDurableObject). Three pins live here:
//
//   • the QUIET CLOCK's reason to exist: a probe (`itx.facets.get('core').snapshot()`) on a
//     never-touched ctx MATERIALIZES it (the constructor's `Stream.appendCreatedAndWokenEvents()` writes created + woken
//     before any door opens) yet arms NO alarm — #recordActivityForQuietClock arms only when there is something
//     to quiesce (a live facet, a paged-in rpc stub); only storage.getAlarm() can see that (the
//     e2e lane pins the records but cannot read the alarm);
//   • the provide door's SHAPE: it canonicalizes the path on its own (a Workers-RPC caller
//     bypasses the edge canonicalizer), and a mount is `{ path, target, providedAtOffset }` and
//     NOTHING else — no lane, no delivery, no processor field (capability-table 5.0.0: HOW a
//     target is served is never written on a mount; the subscriptions layer decides by
//     evaluating its own target, subscription-delivery.ts);
//   • revokeCapability's `void` return on both spellings (`{ providedAtOffset }` | `{ path }`) — a
//     mount and a parked stub are SEPARATE things: revoking a live mount pops the row and never
//     touches a transport. The stub stays in `itx.rpcStubs` until the session that parked it
//     closes it.

import { runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { print, type Expression } from "../src/context/expression.ts";
import { openSession, stub } from "./support.ts";

/** One mount row as the core snapshot serializes it (the mounts are `core` state; the reduced
 *  `target` is the parsed Expression — `print` it to compare against the string the door was given). */
type MountRow = { path: string[]; target: Expression; providedAtOffset: number };
const mountsOf = async (ctx: string): Promise<MountRow[]> =>
  (
    (await stub(ctx).invoke("itx.facets.get('core').snapshot()")) as {
      state: { mounts: MountRow[] };
    }
  ).state.mounts;

/** The live value under test — a method receiver, so the registry reach is the documented
 *  pipelinable spelling `itx.rpcStubs.get('<key>').ping()`. */
class Alive extends RpcTarget {
  ping(): string {
    return "alive";
  }
}

test("a core-snapshot probe on a NEVER-TOUCHED ctx materializes it (created@1 + woken@2, incarnation 1) yet arms NO alarm — no facet, no stub, nothing to quiesce; a plain append arms none either", async () => {
  await runInDurableObject(stub("prj_doors_virginprobe"), async (instance, state) => {
    // ANY door materializes a context: the constructor's `Stream.appendCreatedAndWokenEvents()` wrote the birth certificate
    // and the wake record before this probe could run (the apps/os shape). What the probe must NOT
    // do is arm the quiet clock: #recordActivityForQuietClock arms only when there is something to quiesce — a
    // live facet or a paged-in rpc stub — and this ctx has neither (a durable alarm write + a billed
    // wake for nothing was the arc review's catch).
    const snap = (await instance.invoke("itx.facets.get('core').snapshot()")) as {
      offset: number;
      state: { projectId?: string; path?: string; createdAt?: string; incarnation?: number };
    };
    expect(snap.state).toMatchObject({
      projectId: "prj_doors_virginprobe",
      path: "/",
      incarnation: 1,
    });
    expect(typeof snap.state.createdAt).toBe("string");
    expect(snap.offset).toBe(2); // reduced through the wake record
    expect(await state.storage.getAlarm()).toBeNull(); // THE pin: no quiet-clock arm
    expect(instance.read(0).events.map((e) => [e.type, e.offset])).toEqual([
      ["events.iterate.com/stream/created", 1],
      ["events.iterate.com/stream/woken", 2],
    ]);
    expect(state.storage.kv.get("incarnation")).toBe(1);
    // A plain append is activity — but still nothing to quiesce, so still no alarm. (Offset 4: past
    // created, woken and core's ephemeral live-state delta for the wake commit at 3.)
    const [mark] = (await instance.append({ type: "mark" })) as unknown as { offset: number }[];
    expect(mark.offset).toBe(4);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

// #recordActivityForQuietClock runs at the TOP of invoke(), BEFORE the call pages the stub in — so the rpcStubs
// handle re-notes in a `finally` (like #invokeFacet does): a context whose only pinning resource is
// a paged-in stub arms its quiet clock on THAT invoke, not one activity late.
test("the quiet clock arms as soon as there IS something to quiesce: the invoke that pages an rpc stub in", async () => {
  const ctx = "prj_doors_stubarms";
  await runInDurableObject(stub(ctx), async (_instance, state) => {
    // Park a live capability (a hibernatable pager socket — a transport, not yet a paged-in stub)…
    const itx = await (await openSession()).authenticate().projects.get(ctx);
    await itx.provide("itx.armcap", new Alive());
    expect(await state.storage.getAlarm()).toBeNull(); // a parked stub alone quiesces nothing
    // …then a call pages it in: a RETAINED stub pins this actor, so the clock must arm NOW.
    expect(await itx.invokeCapability("itx.armcap.ping()")).toBe("alive");
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
