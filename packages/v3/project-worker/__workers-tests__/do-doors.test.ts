// __workers-tests__/do-doors.test.ts — the IterateContextDurableObject's Workers-RPC doors,
// pinned at zero distance (the pool lane is the only one that can BOTH call the DO verbs raw —
// no capnweb edge folding the returns away — AND inspect the DO's own storage via
// runInDurableObject). Three arc-review pins live here:
//
//   • the VIRGIN-PROBE alarm blind spot: the harness-lane storage-laziness test
//     (failing-appsos-mined.test.ts) pins incarnation/tables but cannot read storage.getAlarm();
//     this file closes that gap — a probe must not arm the quiet clock on a never-touched ctx;
//   • the provide door's canonicalize-before-lane-stamp rule (a non-canonical subscribers
//     spelling must land a LANED row, not a silently-dead laneless one);
//   • revokeCapability's `{ revokedLivePaths }` return — the contract the edge's per-path
//     Parking disposal rides, on BOTH revoke spellings.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { canonicalName } from "../src/core/durable-object-names.ts";
import type { IterateContextDurableObject } from "../src/stream-durable-object.ts";

const stub = (ctx: string) =>
  (
    env as unknown as { CONTEXT: DurableObjectNamespace<IterateContextDurableObject> }
  ).CONTEXT.getByName(canonicalName(ctx));

test("a core-snapshot probe on a VIRGIN ctx arms NO alarm and mints NO storage — the first real append arms it", async () => {
  await runInDurableObject(stub("prj_doors_virginprobe"), async (instance, state) => {
    // The hostState-replacement probe rides invoke() → #noteActivity; on a never-touched context
    // it must not write the quiet-clock alarm (a durable write + a billed wake on a ctx that was
    // only probed — the storage-lazy doctrine's blind spot the arc review caught).
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

test("provideCapability canonicalizes BEFORE lane-stamping — a non-canonical subscribers spelling still gets its lane", async () => {
  // A Workers-RPC caller bypasses the edge canonicalizer, so the DO door must hold on its own:
  // pre-fix, the raw-string `startsWith("itx.subscribers.")` check missed " itx.subscribers.x"
  // while the reduce stored the CANONICAL path — a LANELESS subscriber row no fan-out lane serves
  // (connected wants lane 'connected', the pump 'facet', the forwarder 'durable': silently dead,
  // with a success receipt). Pinned on the connected lane (`live: true`); the durable-lane ghost
  // is pinned in the harness lane (failing-appsos-mined.test.ts), where the forwarder facet can
  // actually materialize.
  const s = stub("prj_doors_ghostlane");
  await s.provideCapability({ path: " itx.subscribers.ghost", live: true });
  const snap = (await s.invoke("itx.facets.get('capability-table').snapshot()")) as {
    state: { mounts: { path: string[]; live?: true; lane?: string }[] };
  };
  const row = snap.state.mounts.find((m) => m.path.join(".") === "itx.subscribers.ghost");
  expect(row).toBeDefined(); // stored CANONICAL — the one-canonicalizer rule
  expect(row!.live).toBe(true);
  expect(row!.lane).toBe("connected"); // stamped from the canonical spelling
});

test("revokeCapability returns the revoked LIVE rows' paths — both spellings, empty when nothing live popped", async () => {
  const s = stub("prj_doors_revokedlive");
  const live = await s.provideCapability({ path: "itx.livecap", live: true });
  const alias = await s.provideCapability({ path: "itx.aliascap", target: "itx.whoami" });
  // By OFFSET — the pipelined provide+revoke spelling, the branch that used to drop the return
  // on the floor and leak the edge's Parking relay.
  expect(await s.revokeCapability({ providedAtOffset: live.providedAtOffset })).toEqual({
    revokedLivePaths: ["itx.livecap"],
  });
  // An EXPRESSION mount is not live — nothing for the edge to dispose.
  expect(await s.revokeCapability({ path: "itx.aliascap" })).toEqual({ revokedLivePaths: [] });
  // Idempotent re-revoke of an already-gone row: same shape, still empty.
  expect(await s.revokeCapability({ providedAtOffset: alias.providedAtOffset })).toEqual({
    revokedLivePaths: [],
  });
});
