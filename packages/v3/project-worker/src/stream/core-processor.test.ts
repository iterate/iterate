// The core reduce's executable spec (src/stream/core-processor.ts): ONE pure reduce of the context's
// ten control events into the state the DO reads SYNCHRONOUSLY at its doors — identity (created),
// incarnation (woken), the pause latch (paused/resumed), the capability table (a SHADOW STACK:
// provided pushes, revoked-by-offset pops exactly one) and the subscriptions table (by name:
// configured REPLACES, removed drops, delivery-halted marks, delivery-resumed clears the halt and
// records the seek). No clock, no effects: the same log always reduces to the same state, an ephemeral
// event never reduces (the checkpoint must rebuild from the durable log alone), and a malformed
// hand-appended event is SKIPPED, never a wedge. The DOORS that build these events are pinned beside
// their modules (context/capability-table.test.ts, stream/subscriptions.test.ts).
import { describe, expect, test } from "vitest";
import { parse, print } from "../context/expression.ts";
import { CoreContract, CoreStreamProcessor, type CoreState } from "./core-processor.ts";
import type { StreamEvent } from "./events.ts";

const proc = new CoreStreamProcessor();
/** A committed DURABLE event at `offset`; createdAt derives from the offset so identity pins read. */
const at = (offset: number, type: string, payload?: Record<string, unknown>): StreamEvent => ({
  type,
  ...(payload && { payload }),
  offset,
  createdAt: new Date(offset * 1000).toISOString(),
  path: "/",
});
const reduceAll = (events: StreamEvent[], initial = proc.contract.initialState()): CoreState =>
  events.reduce((s, e) => proc.reduce({ event: e, state: s }) ?? s, initial);

describe("the contract", () => {
  test("slug `core` v3.0.0; the schema-initial state; consumes EXACTLY its ten control events (an inline reduce reduces only what it consumes)", () => {
    expect(proc.contract.slug).toBe("core");
    expect(proc.contract.version).toBe("3.0.0");
    expect(proc.contract.initialState()).toEqual({ paused: null, mounts: [], subscriptions: {} });
    expect(proc.contract.consumes).toEqual([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "events.iterate.com/stream/paused",
      "events.iterate.com/stream/resumed",
      "events.iterate.com/capability-table/capability-provided",
      "events.iterate.com/capability-table/capability-revoked",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-removed",
      "events.iterate.com/stream/subscription-delivery-halted",
      "events.iterate.com/stream/subscription-delivery-resumed",
    ]);
    expect(proc.contract.emits).toEqual([]);
  });
});

describe("identity, incarnation, the pause latch", () => {
  test("created → projectId, path, createdAt (the birth certificate's own timestamp)", () => {
    const born = at(1, "events.iterate.com/stream/created", { projectId: "prj_t", path: "/" });
    const s = reduceAll([born]);
    expect(s.projectId).toBe("prj_t");
    expect(s.path).toBe("/");
    expect(s.createdAt).toBe(born.createdAt);
  });

  test("woken → incarnation; every wake overwrites (growth across idle is the hibernation tell); identity untouched", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/created", { projectId: "prj_t", path: "/" }),
      at(2, "events.iterate.com/stream/woken", { incarnation: 1 }),
      at(3, "events.iterate.com/stream/woken", { incarnation: 2 }),
    ]);
    expect(s.incarnation).toBe(2);
    expect(s.projectId).toBe("prj_t");
  });

  test("pause is a latch: paused → resumed round-trips; reason carried", () => {
    const paused = reduceAll([
      at(1, "events.iterate.com/stream/paused", { reason: "maintenance" }),
    ]);
    expect(paused.paused).toEqual({ reason: "maintenance" });
    expect(reduceAll([at(2, "events.iterate.com/stream/resumed")], paused).paused).toBeNull();
  });

  test('paused without a reason defaults to "paused" — in the reduce AND in the built event', () => {
    expect(reduceAll([at(1, "events.iterate.com/stream/paused")]).paused).toEqual({
      reason: "paused",
    });
    expect(reduceAll([at(1, "events.iterate.com/stream/paused", {})]).paused).toEqual({
      reason: "paused",
    });
    expect(CoreContract.buildEvent({ type: "events.iterate.com/stream/paused" }).payload).toEqual({
      reason: "paused",
    });
  });
});

describe("the capability table — a shadow stack", () => {
  test("provided pushes a PARSED mount (string at rest, structured in state) whose providedAtOffset is the event's own offset", () => {
    const s = reduceAll([
      at(7, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.db",
        target: "itx.facets.get('tab-1')",
      }),
    ]);
    expect(s.mounts).toEqual([
      { path: ["itx", "db"], target: parse("itx.facets.get('tab-1')"), providedAtOffset: 7 },
    ]);
  });

  test("same-path mounts COEXIST in log order (a stack, never a replace); revoked pops EXACTLY the named offset — what's beneath stands", () => {
    const stacked = reduceAll([
      at(1, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.greeter",
        target: "itx.tab1",
      }),
      at(2, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.greeter",
        target: "itx.tab2",
      }),
      at(3, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.other",
        target: "itx.kv",
      }),
    ]);
    expect(stacked.mounts.map((m) => m.providedAtOffset)).toEqual([1, 2, 3]);
    const popped = reduceAll(
      [at(4, "events.iterate.com/capability-table/capability-revoked", { providedAtOffset: 2 })],
      stacked,
    );
    expect(popped.mounts.map((m) => [m.path.join("."), m.providedAtOffset])).toEqual([
      ["itx.greeter", 1],
      ["itx.other", 3],
    ]);
    // revoking an offset that is not mounted (already popped, or never provided) changes nothing
    const again = reduceAll(
      [
        at(5, "events.iterate.com/capability-table/capability-revoked", { providedAtOffset: 2 }),
        at(6, "events.iterate.com/capability-table/capability-revoked", { providedAtOffset: 999 }),
      ],
      popped,
    );
    expect(again).toEqual(popped);
  });

  test("a malformed provided (a path with a call step, an unbalanced target) is SKIPPED — no mount — and later events still reduce", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.broken(",
        target: "itx.kv",
      }),
      at(2, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.call()",
        target: "itx.kv",
      }),
      at(3, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.dangling",
        target: "itx.kv.get(",
      }),
      at(4, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.fine",
        target: "itx.kv",
      }),
    ]);
    expect(s.mounts.map((m) => [m.path.join("."), m.providedAtOffset])).toEqual([["itx.fine", 4]]);
  });
});

describe("the subscriptions table — by name", () => {
  test("configured: a row is `{ target (parsed), consumes?, configuredAtOffset }` — the event's own offset is its identity", () => {
    const e = at(3, "events.iterate.com/stream/subscription-configured", {
      name: "tab",
      target: "itx.rpcStubs.get('itx.subscriptions.tab')",
      consumes: ["mark"],
    });
    expect(reduceAll([e]).subscriptions).toEqual({
      tab: {
        target: parse("itx.rpcStubs.get('itx.subscriptions.tab')"),
        consumes: ["mark"],
        configuredAtOffset: 3,
      },
    });
  });

  test("configured without `consumes` stores no `consumes` key at all (absent = every durable event)", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "all",
        target: "itx.facets.get('tally').processEventBatch",
      }),
    ]);
    expect(s.subscriptions.all).not.toHaveProperty("consumes");
  });

  test("configured with the SAME NAME REPLACES the row — no shadow stack, the old target and filter are gone", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.old.processEventBatch",
        consumes: ["a"],
      }),
      at(2, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.new.processEventBatch",
      }),
    ]);
    expect(Object.keys(s.subscriptions)).toEqual(["digest"]);
    expect(print(s.subscriptions.digest.target)).toBe("itx.new.processEventBatch");
    expect(s.subscriptions.digest.configuredAtOffset).toBe(2);
    expect(s.subscriptions.digest).not.toHaveProperty("consumes"); // the replacement's filter, not the old one's
  });

  test("removed drops the row; removing an unknown name → undefined (keep the state), never a throw or a phantom row", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", { name: "a", target: "itx.x.f" }),
      at(2, "events.iterate.com/stream/subscription-configured", { name: "b", target: "itx.y.f" }),
      at(3, "events.iterate.com/stream/subscription-removed", { name: "a" }),
    ]);
    expect(Object.keys(s.subscriptions)).toEqual(["b"]);
    expect(
      proc.reduce({
        event: at(4, "events.iterate.com/stream/subscription-removed", { name: "ghost" }),
        state: s,
      }),
    ).toBeUndefined();
  });

  test("delivery-halted sets `halted { afterOffset, attempts, error? }` on the row (the loop's fact); unknown name → no-op", () => {
    const configured = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.digest.processEventBatch",
      }),
    ]);
    const halted = reduceAll(
      [
        at(2, "events.iterate.com/stream/subscription-delivery-halted", {
          name: "digest",
          afterOffset: 7,
          attempts: 15,
          error: "boom",
        }),
      ],
      configured,
    );
    expect(halted.subscriptions.digest.halted).toEqual({
      afterOffset: 7,
      attempts: 15,
      error: "boom",
    });
    // without `error` the key is absent, not undefined-valued
    const rehalted = reduceAll(
      [
        at(3, "events.iterate.com/stream/subscription-delivery-halted", {
          name: "digest",
          afterOffset: 9,
          attempts: 1,
        }),
      ],
      halted,
    );
    expect(rehalted.subscriptions.digest.halted).toEqual({ afterOffset: 9, attempts: 1 });
    // a halt for a name that has no row is dropped on the floor
    expect(
      proc.reduce({
        event: at(4, "events.iterate.com/stream/subscription-delivery-halted", {
          name: "nobody",
          afterOffset: 1,
          attempts: 1,
        }),
        state: rehalted,
      }),
    ).toBeUndefined();
  });

  test("delivery-resumed CLEARS `halted` and records `resumed { afterOffset?, atOffset }` — atOffset is the resume event's own offset; unknown name → no-op", () => {
    const halted = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "digest",
        target: "itx.digest.processEventBatch",
      }),
      at(2, "events.iterate.com/stream/subscription-delivery-halted", {
        name: "digest",
        afterOffset: 7,
        attempts: 15,
      }),
    ]);
    const sought = reduceAll(
      [
        at(3, "events.iterate.com/stream/subscription-delivery-resumed", {
          name: "digest",
          afterOffset: 8,
        }),
      ],
      halted,
    );
    expect(sought.subscriptions.digest).not.toHaveProperty("halted");
    expect(sought.subscriptions.digest.resumed).toEqual({ afterOffset: 8, atOffset: 3 });
    // a plain un-halt (no seek): `resumed` carries only the generation
    const plain = reduceAll(
      [at(4, "events.iterate.com/stream/subscription-delivery-resumed", { name: "digest" })],
      sought,
    );
    expect(plain.subscriptions.digest.resumed).toEqual({ atOffset: 4 });
    // and it keeps the row's other fields intact
    expect(print(plain.subscriptions.digest.target)).toBe("itx.digest.processEventBatch");
    expect(plain.subscriptions.digest.configuredAtOffset).toBe(1);
    expect(
      proc.reduce({
        event: at(5, "events.iterate.com/stream/subscription-delivery-resumed", { name: "nobody" }),
        state: plain,
      }),
    ).toBeUndefined();
  });

  test("a malformed target is SKIPPED (no row), and later events still reduce — one bad hand-appended event never wedges the table", () => {
    const s = reduceAll([
      at(1, "events.iterate.com/stream/subscription-configured", {
        name: "broken",
        target: "itx.broken(", // does not parse
      }),
      at(2, "events.iterate.com/stream/subscription-configured", {
        name: "fine",
        target: "itx.whoami",
      }),
    ]);
    expect(Object.keys(s.subscriptions)).toEqual(["fine"]);
  });
});

describe("purity", () => {
  test("an EPHEMERAL event is never reduced, whatever its type — the state is rebuildable from the durable log alone", () => {
    const state = proc.contract.initialState();
    const ephemeral = (type: string, payload: Record<string, unknown>): StreamEvent => ({
      ...at(1, type, payload),
      ephemeral: true,
    });
    for (const e of [
      ephemeral("events.iterate.com/stream/created", { projectId: "p", path: "/" }),
      ephemeral("events.iterate.com/stream/woken", { incarnation: 9 }),
      ephemeral("events.iterate.com/stream/paused", { reason: "x" }),
      ephemeral("events.iterate.com/capability-table/capability-provided", {
        path: "itx.blip",
        target: "itx.kv",
      }),
      ephemeral("events.iterate.com/stream/subscription-configured", {
        name: "blip",
        target: "itx.whoami",
      }),
    ])
      expect(proc.reduce({ event: e, state })).toBeUndefined();
  });

  test("an event the reduce does not know → undefined (keep the state)", () => {
    expect(
      proc.reduce({ event: at(1, "work"), state: proc.contract.initialState() }),
    ).toBeUndefined();
  });

  test("the reduce rebuilds bit-identically from the log (pure — no wall clock anywhere)", () => {
    const log = [
      at(1, "events.iterate.com/stream/created", { projectId: "prj_t", path: "/" }),
      at(2, "events.iterate.com/stream/woken", { incarnation: 1 }),
      at(3, "events.iterate.com/capability-table/capability-provided", {
        path: "itx.db",
        target: "itx.kv",
      }),
      at(4, "events.iterate.com/stream/subscription-configured", {
        name: "tally",
        target: "itx.facets.get('tally').processEventBatch",
      }),
      at(5, "events.iterate.com/stream/paused", { reason: "r" }),
      at(6, "events.iterate.com/stream/resumed"),
      at(7, "events.iterate.com/stream/woken", { incarnation: 2 }),
    ];
    expect(reduceAll(log)).toEqual(reduceAll(log));
  });
});
