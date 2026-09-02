// The subscriptions layer's executable spec (src/stream/subscriptions.ts): the REDUCE — `configured`
// REPLACES a same-named row (no shadow stack), `removed` drops it, `delivery-halted` marks it,
// `delivery-resumed` clears the halt and records the seek — and the two idempotent DOORS
// (`configure` / `remove`), which append nothing when the table already says what they would say.
// A subscription is PURE DATA: a name, a target expression (stored as its printed string), an
// optional `consumes` filter. Nothing here knows HOW a target is served — that is
// subscription-delivery.ts's job, decided by evaluating the target, never by a field on the row.
import { describe, expect, test } from "vitest";
import { parse, print } from "../context/expression.ts";
import type { StreamEvent } from "./events.ts";
import { SubscriptionsProcessor, type SubscriptionsState } from "./subscriptions.ts";
import { memoryStream } from "./test-support.ts";

const setup = () => {
  const { stream, events } = memoryStream();
  const proc = new SubscriptionsProcessor(stream);
  // INLINE HOSTING, exactly like the parent: reduce the durable log per call.
  const reduceAll = (): SubscriptionsState =>
    events.reduce(
      (st, e) => proc.reduce({ event: e, state: st }) ?? st,
      proc.contract.initialState(),
    );
  /** Append a raw event as the stream would — a hand-written row, or a fact the delivery loop /
   *  an operator appends (`delivery-halted` / `delivery-resumed` have no door on this class). */
  const append = (type: string, payload: Record<string, unknown>): StreamEvent =>
    (stream.append({ type, payload }) as StreamEvent[])[0];
  return {
    events,
    proc,
    reduceAll,
    append,
    rows: () => reduceAll().subscriptions,
    configure: (input: { name: string; target: string | unknown[]; consumes?: string[] }) =>
      proc.configure(reduceAll(), input as Parameters<typeof proc.configure>[1]),
    remove: (name: string) => proc.remove(reduceAll(), name),
  };
};

describe("the reduce — a pure fold of the four events", () => {
  test("configured: a row is `{ target (parsed), consumes?, configuredAtOffset }` — the event's own offset is its identity", () => {
    const { append, rows } = setup();
    const e = append("events.iterate.com/stream/subscription-configured", {
      name: "tab",
      target: "itx.rpcStubs.get('itx.subscriptions.tab')",
      consumes: ["mark"],
    });
    expect(rows()).toEqual({
      tab: {
        target: parse("itx.rpcStubs.get('itx.subscriptions.tab')"),
        consumes: ["mark"],
        configuredAtOffset: e.offset,
      },
    });
  });

  test("configured without `consumes` stores no `consumes` key at all (absent = every durable event)", () => {
    const { append, rows } = setup();
    append("events.iterate.com/stream/subscription-configured", {
      name: "all",
      target: "itx.facets.get('tally').processEventBatch",
    });
    expect(rows().all).not.toHaveProperty("consumes");
  });

  test("configured with the SAME NAME REPLACES the row — no shadow stack, the old target is gone", () => {
    const { append, rows } = setup();
    append("events.iterate.com/stream/subscription-configured", {
      name: "digest",
      target: "itx.old.processEventBatch",
      consumes: ["a"],
    });
    const second = append("events.iterate.com/stream/subscription-configured", {
      name: "digest",
      target: "itx.new.processEventBatch",
    });
    expect(Object.keys(rows())).toEqual(["digest"]);
    expect(print(rows().digest.target)).toBe("itx.new.processEventBatch");
    expect(rows().digest.configuredAtOffset).toBe(second.offset);
    expect(rows().digest).not.toHaveProperty("consumes"); // the replacement's filter, not the old one's
  });

  test("removed drops the row; removing an unknown name changes nothing", () => {
    const { append, rows, proc } = setup();
    append("events.iterate.com/stream/subscription-configured", { name: "a", target: "itx.x.f" });
    append("events.iterate.com/stream/subscription-configured", { name: "b", target: "itx.y.f" });
    append("events.iterate.com/stream/subscription-removed", { name: "a" });
    expect(Object.keys(rows())).toEqual(["b"]);
    // unknown name → `undefined` (keep the current state), never a throw or a phantom row
    const state = rows();
    expect(
      proc.reduce({
        event: {
          type: "events.iterate.com/stream/subscription-removed",
          payload: { name: "ghost" },
          offset: 99,
          createdAt: "",
          path: "/",
        },
        state: { subscriptions: state },
      }),
    ).toBeUndefined();
  });

  test("delivery-halted sets `halted { afterOffset, attempts, error? }` on the row (the loop's fact); unknown name → no-op", () => {
    const { append, rows } = setup();
    append("events.iterate.com/stream/subscription-configured", {
      name: "digest",
      target: "itx.digest.processEventBatch",
    });
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 7,
      attempts: 15,
      error: "boom",
    });
    expect(rows().digest.halted).toEqual({ afterOffset: 7, attempts: 15, error: "boom" });
    // without `error` the key is absent, not undefined-valued
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 9,
      attempts: 1,
    });
    expect(rows().digest.halted).toEqual({ afterOffset: 9, attempts: 1 });
    // a halt for a name that has no row is dropped on the floor
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "nobody",
      afterOffset: 1,
      attempts: 1,
    });
    expect(Object.keys(rows())).toEqual(["digest"]);
  });

  test("delivery-resumed CLEARS `halted` and records `resumed { afterOffset?, atOffset }` — atOffset is the resume event's own offset", () => {
    const { append, rows } = setup();
    append("events.iterate.com/stream/subscription-configured", {
      name: "digest",
      target: "itx.digest.processEventBatch",
    });
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 7,
      attempts: 15,
    });
    const seek = append("events.iterate.com/stream/subscription-delivery-resumed", {
      name: "digest",
      afterOffset: 8,
    });
    expect(rows().digest).not.toHaveProperty("halted");
    expect(rows().digest.resumed).toEqual({ afterOffset: 8, atOffset: seek.offset });
    // a plain un-halt (no seek): `resumed` carries only the generation
    const plain = append("events.iterate.com/stream/subscription-delivery-resumed", {
      name: "digest",
    });
    expect(rows().digest.resumed).toEqual({ atOffset: plain.offset });
    // and it keeps the row's other fields intact
    expect(print(rows().digest.target)).toBe("itx.digest.processEventBatch");
  });

  test("a malformed target is SKIPPED (no row), and later events still reduce — one bad hand-appended event never wedges the table", () => {
    const { append, rows } = setup();
    append("events.iterate.com/stream/subscription-configured", {
      name: "broken",
      target: "itx.broken(", // does not parse
    });
    append("events.iterate.com/stream/subscription-configured", {
      name: "fine",
      target: "itx.whoami",
    });
    expect(Object.keys(rows())).toEqual(["fine"]);
  });

  test("an EPHEMERAL event is never reduced — the table is rebuildable from the durable log alone", () => {
    const { proc } = setup();
    const state = proc.contract.initialState();
    expect(
      proc.reduce({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: { name: "blip", target: "itx.whoami" },
          ephemeral: true,
          offset: 1,
          createdAt: "",
          path: "/",
        },
        state,
      }),
    ).toBeUndefined();
  });
});

describe("the doors — `configure` / `remove`, idempotent against the CURRENT table", () => {
  test("configure appends ONE subscription-configured with the target PRINTED (string at rest) and returns the row's identity", async () => {
    const { configure, events, rows } = setup();
    const out = await configure({
      name: "tally",
      target: ["itx", "facets", ["get", "tally"], "processEventBatch"],
      consumes: ["mark", "tick"],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("events.iterate.com/stream/subscription-configured");
    expect(events[0].payload).toEqual({
      name: "tally",
      target: "itx.facets.get('tally').processEventBatch", // print-canonicalized, human-readable in the log
      consumes: ["mark", "tick"],
    });
    expect(out).toEqual({ name: "tally", configuredAtOffset: events[0].offset });
    expect(rows().tally.configuredAtOffset).toBe(out.configuredAtOffset);
  });

  test("configure omits `consumes` from the payload when none was given", async () => {
    const { configure, events } = setup();
    await configure({ name: "all", target: "itx.digest.processEventBatch" });
    expect(events[0].payload).toEqual({ name: "all", target: "itx.digest.processEventBatch" });
  });

  test("IDEMPOTENT: an identical configure (same target, same filter) appends NOTHING and answers with the EXISTING identity — a reconnect is zero events", async () => {
    const { configure, events } = setup();
    const first = await configure({
      name: "tab",
      target: "itx.rpcStubs.get('itx.subscriptions.tab')",
      consumes: ["mark"],
    });
    const again = await configure({
      name: "tab",
      target: ["itx", "rpcStubs", ["get", "itx.subscriptions.tab"]], // the array spelling of the same target
      consumes: ["mark"],
    });
    expect(again).toEqual(first);
    expect(events).toHaveLength(1);
  });

  test("a CHANGED target appends (replacing the row); a CHANGED filter appends too — `consumes` is compared as an ordered list", async () => {
    const { configure, events, rows } = setup();
    const a = await configure({ name: "w", target: "itx.a.processEventBatch", consumes: ["x"] });
    const b = await configure({ name: "w", target: "itx.b.processEventBatch", consumes: ["x"] });
    expect(b.configuredAtOffset).toBeGreaterThan(a.configuredAtOffset);
    expect(print(rows().w.target)).toBe("itx.b.processEventBatch");
    const c = await configure({
      name: "w",
      target: "itx.b.processEventBatch",
      consumes: ["x", "y"],
    });
    expect(c.configuredAtOffset).toBeGreaterThan(b.configuredAtOffset);
    const d = await configure({ name: "w", target: "itx.b.processEventBatch" }); // filter dropped ⇒ different
    expect(d.configuredAtOffset).toBeGreaterThan(c.configuredAtOffset);
    expect(events).toHaveLength(4);
    expect(Object.keys(rows())).toEqual(["w"]); // still ONE row — replace, never a stack
  });

  test("a HALTED row is never 'already configured': re-configuring it identically appends, and the fresh row carries no halt", async () => {
    const { configure, append, events, rows } = setup();
    await configure({ name: "digest", target: "itx.digest.processEventBatch" });
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 1,
      attempts: 15,
    });
    expect(rows().digest.halted).toBeDefined();
    await configure({ name: "digest", target: "itx.digest.processEventBatch" });
    expect(events.filter((e) => e.type.endsWith("subscription-configured"))).toHaveLength(2);
    expect(rows().digest).not.toHaveProperty("halted");
  });

  test("the target must be rooted at `itx` (a bare built-in root is unspellable)", async () => {
    const { configure, events } = setup();
    await expect(configure({ name: "evil", target: "kv.get('a')" })).rejects.toThrow(
      /must be rooted at "itx"/,
    );
    expect(events).toHaveLength(0);
  });

  test("a name is ONE segment, [A-Za-z0-9_-]+ — a dotted or spaced name is refused at the door, nothing appended", async () => {
    const { configure, remove, events } = setup();
    await expect(configure({ name: "a.b", target: "itx.whoami" })).rejects.toThrow(/one segment/);
    await expect(configure({ name: "has space", target: "itx.whoami" })).rejects.toThrow(
      /one segment/,
    );
    await expect(remove("a.b")).rejects.toThrow(/one segment/);
    expect(events).toHaveLength(0);
  });

  test("remove appends ONE subscription-removed for a live row; removing an unknown name appends NOTHING", async () => {
    const { configure, remove, events, rows } = setup();
    await configure({ name: "tab", target: "itx.rpcStubs.get('itx.subscriptions.tab')" });
    await remove("tab");
    expect(events.map((e) => e.type)).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-removed",
    ]);
    expect(events[1].payload).toEqual({ name: "tab" });
    expect(rows()).toEqual({});
    await remove("tab"); // already gone
    await remove("never-there");
    expect(events).toHaveLength(2);
  });

  test("REPLACE then REMOVE: one removed event clears the name whatever its history (no stack to unwind)", async () => {
    const { configure, remove, rows } = setup();
    await configure({ name: "w", target: "itx.a.processEventBatch" });
    await configure({ name: "w", target: "itx.b.processEventBatch" });
    await configure({ name: "w", target: "itx.c.processEventBatch" });
    await remove("w");
    expect(rows()).toEqual({});
  });
});
