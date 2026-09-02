// The subscriptions table's two COMMANDS (src/stream/subscriptions.ts): `subscriptionConfiguredEvent`
// and `subscriptionRemovedEvent` BUILD the events the caller appends — `null` when the CURRENT rows
// already say what they would say (a reconnecting client's re-subscribe, a repeated remove: ZERO
// events), the event otherwise; a refusal (a dotted name, the reserved `core`, a target not rooted
// at itx) THROWS at the door, nothing appended. A subscription is PURE DATA — a name, a target
// expression stored as its printed string, an optional `consumes` filter; nothing here knows HOW a
// target is served (subscription-delivery.ts decides that by evaluating it). The rows THEMSELVES are
// `core` state, folded here through `CoreStreamProcessor` exactly as the DO does; the reduce's own
// pins (replace / drop / halted / resumed) live in core-processor.test.ts.
import { describe, expect, test } from "vitest";
import { print, type ItxExpression } from "../context/expression.ts";
import { CoreStreamProcessor, type Subscription } from "./core-processor.ts";
import type { StreamEvent } from "./events.ts";
import { subscriptionConfiguredEvent, subscriptionRemovedEvent } from "./subscriptions.ts";
import { memoryStream } from "./test-support.ts";

const setup = () => {
  const { stream, events } = memoryStream();
  const core = new CoreStreamProcessor();
  // INLINE HOSTING, exactly like the parent: the rows are core state, folded from the durable log
  // per call.
  const rows = (): Record<string, Subscription> =>
    events.reduce(
      (st, e) => core.reduce({ event: e, state: st }) ?? st,
      core.contract.initialState(),
    ).subscriptions;
  /** The DO's `configureSubscription` / `removeSubscription`: ask the door, append what comes back
   *  (if anything), hand back what the door said so a pin can see null vs event. */
  const configure = (input: { name: string; target: ItxExpression; consumes?: string[] }) => {
    const event = subscriptionConfiguredEvent(rows(), input);
    if (event) stream.append(event);
    return event;
  };
  const remove = (name: string) => {
    const event = subscriptionRemovedEvent(rows(), name);
    if (event) stream.append(event);
    return event;
  };
  /** Append a raw event as the stream would — a fact the delivery loop appends (`delivery-halted`
   *  has no door on this module). */
  const append = (type: string, payload: Record<string, unknown>): StreamEvent =>
    (stream.append({ type, payload }) as StreamEvent[])[0];
  return { events, rows, configure, remove, append };
};

describe("configure — one event, or null when the table already says so", () => {
  test("builds ONE subscription-configured with the target PRINTED (string at rest); appended, the row's identity is that event's offset", () => {
    const { configure, events, rows } = setup();
    const event = configure({
      name: "tally",
      target: ["itx", "facets", ["get", "tally"], "processEventBatch"],
      consumes: ["mark", "tick"],
    });
    expect(event).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        name: "tally",
        target: "itx.facets.get('tally').processEventBatch", // print-canonicalized, human-readable in the log
        consumes: ["mark", "tick"],
      },
    });
    expect(events).toHaveLength(1);
    expect(rows().tally.configuredAtOffset).toBe(events[0].offset);
  });

  test("omits `consumes` from the payload when none was given", () => {
    const { configure } = setup();
    expect(configure({ name: "all", target: "itx.digest.processEventBatch" })!.payload).toEqual({
      name: "all",
      target: "itx.digest.processEventBatch",
    });
  });

  test("IDEMPOTENT: an identical configure (same target, same filter) is null — the EXISTING identity stands, a reconnect is zero events", () => {
    const { configure, events, rows } = setup();
    configure({
      name: "tab",
      target: "itx.rpcStubs.get('itx.subscriptions.tab')",
      consumes: ["mark"],
    });
    const identity = rows().tab.configuredAtOffset;
    expect(
      configure({
        name: "tab",
        target: ["itx", "rpcStubs", ["get", "itx.subscriptions.tab"]], // the array spelling of the same target
        consumes: ["mark"],
      }),
    ).toBeNull();
    expect(events).toHaveLength(1);
    expect(rows().tab.configuredAtOffset).toBe(identity);
  });

  test("a CHANGED target appends (replacing the row); a CHANGED filter appends too — `consumes` is compared as an ordered list", () => {
    const { configure, events, rows } = setup();
    expect(
      configure({ name: "w", target: "itx.a.processEventBatch", consumes: ["x"] }),
    ).not.toBeNull();
    expect(
      configure({ name: "w", target: "itx.b.processEventBatch", consumes: ["x"] }),
    ).not.toBeNull();
    expect(print(rows().w.target)).toBe("itx.b.processEventBatch");
    expect(
      configure({ name: "w", target: "itx.b.processEventBatch", consumes: ["x", "y"] }),
    ).not.toBeNull();
    expect(
      configure({ name: "w", target: "itx.b.processEventBatch", consumes: ["y", "x"] }), // order matters
    ).not.toBeNull();
    expect(configure({ name: "w", target: "itx.b.processEventBatch" })).not.toBeNull(); // filter dropped ⇒ different
    expect(events).toHaveLength(5);
    expect(Object.keys(rows())).toEqual(["w"]); // still ONE row — replace, never a stack
    expect(rows().w.configuredAtOffset).toBe(events[4].offset);
  });

  test("a HALTED row is never 'already configured': re-configuring it identically appends, and the fresh row carries no halt", () => {
    const { configure, append, events, rows } = setup();
    configure({ name: "digest", target: "itx.digest.processEventBatch" });
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 1,
      attempts: 15,
    });
    expect(rows().digest.halted).toBeDefined();
    expect(configure({ name: "digest", target: "itx.digest.processEventBatch" })).not.toBeNull();
    expect(events.filter((e) => e.type.endsWith("subscription-configured"))).toHaveLength(2);
    expect(rows().digest).not.toHaveProperty("halted");
  });

  test("the target must be rooted at `itx` (a bare built-in root is unspellable) — a throw, nothing appended", () => {
    const { configure, events } = setup();
    expect(() => configure({ name: "evil", target: "kv.get('a')" })).toThrow(
      /must be rooted at "itx"/,
    );
    expect(() => configure({ name: "evil", target: ["kv", ["get", "a"]] })).toThrow(
      /must be rooted at "itx"/,
    );
    expect(events).toHaveLength(0);
  });

  test("a name is ONE segment, [A-Za-z0-9_-]+ — a dotted or spaced name is refused at the door, nothing appended", () => {
    const { configure, remove, events } = setup();
    expect(() => configure({ name: "a.b", target: "itx.whoami" })).toThrow(/one segment/);
    expect(() => configure({ name: "has space", target: "itx.whoami" })).toThrow(/one segment/);
    expect(() => remove("a.b")).toThrow(/one segment/);
    expect(events).toHaveLength(0);
  });

  test("`core` is RESERVED (the core reduce's own address); `capability-table` and `subscriptions` are ordinary names now", () => {
    const { configure, events } = setup();
    expect(() => configure({ name: "core", target: "itx.whoami" })).toThrow(/reserved/);
    expect(events).toHaveLength(0);
    expect(configure({ name: "capability-table", target: "itx.whoami" })).not.toBeNull();
    expect(configure({ name: "subscriptions", target: "itx.whoami" })).not.toBeNull();
    expect(events.map((e) => (e.payload as { name: string }).name)).toEqual([
      "capability-table",
      "subscriptions",
    ]);
  });

  test("the stored target round-trips the codec: a quoted key and an exponent literal reduce back to the string that was stored", () => {
    const { configure, rows } = setup();
    const event = configure({
      name: "odd",
      target: ["itx", "facets", ["get", { "a b": 1e21 }], "processEventBatch"],
    })!;
    expect(print(rows().odd.target)).toBe((event.payload as { target: string }).target);
  });
});

describe("remove — one event for a live row, null for nothing", () => {
  test("builds ONE subscription-removed for a live row; an unknown or already-removed name is null (nothing appended)", () => {
    const { configure, remove, events, rows } = setup();
    configure({ name: "tab", target: "itx.rpcStubs.get('itx.subscriptions.tab')" });
    expect(remove("tab")).toEqual({
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: "tab" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-removed",
    ]);
    expect(rows()).toEqual({});
    expect(remove("tab")).toBeNull(); // already gone
    expect(remove("never-there")).toBeNull();
    expect(events).toHaveLength(2);
  });

  test("REPLACE then REMOVE: one removed event clears the name whatever its history (no stack to unwind)", () => {
    const { configure, remove, rows, events } = setup();
    configure({ name: "w", target: "itx.a.processEventBatch" });
    configure({ name: "w", target: "itx.b.processEventBatch" });
    configure({ name: "w", target: "itx.c.processEventBatch" });
    remove("w");
    expect(rows()).toEqual({});
    expect(events).toHaveLength(4);
  });
});
