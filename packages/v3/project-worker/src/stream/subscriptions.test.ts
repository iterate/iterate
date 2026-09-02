// The subscriptions table's one COMMAND (src/stream/subscriptions.ts): `subscriptionConfiguredEvent`
// BUILDS the event the caller appends — a configure, a replace, or (target null) a removal; a refusal
// (a dotted name, the reserved `core`, a target not rooted at itx) THROWS at the door, nothing
// appended. A subscription is PURE DATA — a name, a target expression stored as its printed string,
// an optional `consumes` filter; nothing here knows HOW a target is served (subscription-delivery.ts
// decides that by evaluating it). The rows THEMSELVES are `core` state, reduced here through
// `CoreStreamProcessor` exactly as the DO does; the reduce's own pins (replace / drop / halted /
// resumed) live in core-processor.test.ts.
import { describe, expect, test } from "vitest";
import { print, type ItxExpressionInput } from "../context/expression.ts";
import { CoreStreamProcessor, type Subscription } from "./core-processor.ts";
import type { StreamEvent } from "./events.ts";
import { subscriptionConfiguredEvent } from "./subscriptions.ts";
import { memoryStream } from "./test-support.ts";

const setup = () => {
  const { stream, events } = memoryStream();
  const core = new CoreStreamProcessor();
  // INLINE, exactly like the DO: the rows are core state, reduced from the durable log per call.
  const rows = (): Record<string, Subscription> =>
    events.reduce(
      (st, e) => core.reduce({ event: e, state: st }) ?? st,
      core.contract.initialState(),
    ).subscriptions;
  /** The edge's `subscribe`: build the event, append it. */
  const configure = (input: {
    name: string;
    target: ItxExpressionInput | null;
    consumes?: string[];
  }) => {
    const event = subscriptionConfiguredEvent(input);
    stream.append(event);
    return event;
  };
  /** Append a raw event as the stream would — a fact the delivery loop appends (`delivery-halted`
   *  has no door on this module). */
  const append = (type: string, payload: Record<string, unknown>): StreamEvent =>
    (stream.append({ type, payload }) as StreamEvent[])[0];
  return { events, rows, configure, append };
};

describe("configure — ONE event: set, replace, or remove", () => {
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
    expect(configure({ name: "all", target: "itx.digest.processEventBatch" }).payload).toEqual({
      name: "all",
      target: "itx.digest.processEventBatch",
    });
  });

  test("the SAME NAME REPLACES the row — target and filter of the newest configure, never a stack", () => {
    const { configure, events, rows } = setup();
    configure({ name: "w", target: "itx.a.processEventBatch", consumes: ["x"] });
    configure({ name: "w", target: "itx.b.processEventBatch" });
    expect(events).toHaveLength(2);
    expect(Object.keys(rows())).toEqual(["w"]);
    expect(print(rows().w.target)).toBe("itx.b.processEventBatch");
    expect(rows().w).not.toHaveProperty("consumes"); // the replacement's filter, not the old one's
    expect(rows().w.configuredAtOffset).toBe(events[1].offset);
  });

  test("a HALTED row re-configured identically gets a fresh row that carries no halt", () => {
    const { configure, append, rows } = setup();
    configure({ name: "digest", target: "itx.digest.processEventBatch" });
    append("events.iterate.com/stream/subscription-delivery-halted", {
      name: "digest",
      afterOffset: 1,
      attempts: 15,
    });
    expect(rows().digest.halted).toBeDefined();
    configure({ name: "digest", target: "itx.digest.processEventBatch" });
    expect(rows().digest).not.toHaveProperty("halted");
  });

  test("a NULL target is the removal: the same event, target null (and no consumes); an unknown name is a no-op through the reduce", () => {
    const { configure, events, rows } = setup();
    configure({ name: "tab", target: "itx.rpcStubs.get('itx.subscriptions.tab')" });
    expect(configure({ name: "tab", target: null, consumes: ["ignored"] })).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      payload: { name: "tab", target: null },
    });
    expect(rows()).toEqual({});
    configure({ name: "never-there", target: null });
    expect(events).toHaveLength(3);
    expect(rows()).toEqual({});
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
    const { configure, events } = setup();
    expect(() => configure({ name: "a.b", target: "itx.whoami" })).toThrow(/one segment/);
    expect(() => configure({ name: "has space", target: "itx.whoami" })).toThrow(/one segment/);
    expect(() => configure({ name: "a.b", target: null })).toThrow(/one segment/);
    expect(events).toHaveLength(0);
  });

  test("`core` is RESERVED (the core reduce's own address); other names are ordinary", () => {
    const { configure, events } = setup();
    expect(() => configure({ name: "core", target: "itx.whoami" })).toThrow(/reserved/);
    expect(events).toHaveLength(0);
    configure({ name: "subscriptions", target: "itx.whoami" });
    expect(events.map((e) => (e.payload as { name: string }).name)).toEqual(["subscriptions"]);
  });

  test("the stored target round-trips the codec: a quoted key and an exponent literal reduce back to the string that was stored", () => {
    const { configure, rows } = setup();
    const event = configure({
      name: "odd",
      target: ["itx", "facets", ["get", { "a b": 1e21 }], "processEventBatch"],
    });
    expect(print(rows().odd.target)).toBe((event.payload as { target: string }).target);
  });
});
