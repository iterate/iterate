import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../shared/event.ts";
import {
  GROUP_COMPONENT,
  groupFeedData,
  INITIAL_FEED_STATE,
  MAX_GROUP_EVENTS,
  planFeedOps,
} from "./grouping.ts";

function event(offset: number, type: string): StreamEvent {
  return { offset, type, createdAt: new Date(0).toISOString(), payload: { offset } };
}

const CREATED = "events.iterate.com/stream/created";
const WOKEN = "events.iterate.com/stream/woken";
const CHILD = "events.iterate.com/stream/child-stream-created";
const DEBUG = "events.iterate.com/debug/random-event";

describe("event-feed grouping", () => {
  it("writes specific-renderer events as their own singleton rows", () => {
    const e1 = event(1, CREATED);
    const e2 = event(2, WOKEN);
    const e3 = event(3, CHILD);
    const { ops, endState } = planFeedOps(INITIAL_FEED_STATE, [e1, e2, e3]);
    expect(ops).toEqual([
      {
        kind: "insert",
        localIndex: 0,
        component: "stream.created",
        firstOffset: 1,
        lastOffset: 1,
        eventCount: 1,
        data: { events: [e1] },
      },
      {
        kind: "insert",
        localIndex: 1,
        component: "stream.woken",
        firstOffset: 2,
        lastOffset: 2,
        eventCount: 1,
        data: { events: [e2] },
      },
      {
        kind: "insert",
        localIndex: 2,
        component: "stream.child-stream-created",
        firstOffset: 3,
        lastOffset: 3,
        eventCount: 1,
        data: { events: [e3] },
      },
    ]);
    expect(endState).toEqual({ open: null, nextLocalIndex: 3 });
  });

  it("collapses a run of non-specific events of the same type into ONE coalesced insert op", () => {
    const e1 = event(1, DEBUG);
    const e2 = event(2, DEBUG);
    const e3 = event(3, DEBUG);
    const { ops, endState } = planFeedOps(INITIAL_FEED_STATE, [e1, e2, e3]);
    // The whole same-type run touches local_index 0 once: a single upsert carrying
    // the final lastOffset/eventCount/data, not one cumulative op per event.
    expect(ops).toEqual([
      {
        kind: "insert",
        localIndex: 0,
        component: GROUP_COMPONENT,
        firstOffset: 1,
        lastOffset: 3,
        eventCount: 3,
        data: groupFeedData(DEBUG, [e1, e2, e3]),
      },
    ]);
    expect(endState).toEqual({
      open: {
        localIndex: 0,
        firstOffset: 1,
        lastOffset: 3,
        eventCount: 3,
        eventType: DEBUG,
        events: [e1, e2, e3],
      },
      nextLocalIndex: 1,
    });
  });

  it("starts a new group row when the event type changes", () => {
    const other = "events.iterate.com/debug/other-event";
    const e1 = event(1, DEBUG);
    const e2 = event(2, other);
    const e3 = event(3, DEBUG);
    const { ops, endState } = planFeedOps(INITIAL_FEED_STATE, [e1, e2, e3]);
    expect(ops).toEqual([
      {
        kind: "insert",
        localIndex: 0,
        component: GROUP_COMPONENT,
        firstOffset: 1,
        lastOffset: 1,
        eventCount: 1,
        data: groupFeedData(DEBUG, [e1]),
      },
      {
        kind: "insert",
        localIndex: 1,
        component: GROUP_COMPONENT,
        firstOffset: 2,
        lastOffset: 2,
        eventCount: 1,
        data: groupFeedData(other, [e2]),
      },
      {
        kind: "insert",
        localIndex: 2,
        component: GROUP_COMPONENT,
        firstOffset: 3,
        lastOffset: 3,
        eventCount: 1,
        data: groupFeedData(DEBUG, [e3]),
      },
    ]);
    expect(endState).toEqual({
      open: {
        localIndex: 2,
        firstOffset: 3,
        lastOffset: 3,
        eventCount: 1,
        eventType: DEBUG,
        events: [e3],
      },
      nextLocalIndex: 3,
    });
  });

  it("closes the open group when a specific-renderer event arrives, then opens a fresh group", () => {
    const e1 = event(1, DEBUG);
    const e2 = event(2, DEBUG);
    const e3 = event(3, WOKEN);
    const e4 = event(4, DEBUG);
    const events = [e1, e2, e3, e4];
    const { ops, endState } = planFeedOps(INITIAL_FEED_STATE, events);
    expect(ops).toEqual([
      {
        kind: "insert",
        localIndex: 0,
        component: GROUP_COMPONENT,
        firstOffset: 1,
        lastOffset: 2,
        eventCount: 2,
        data: groupFeedData(DEBUG, [e1, e2]),
      },
      {
        kind: "insert",
        localIndex: 1,
        component: "stream.woken",
        firstOffset: 3,
        lastOffset: 3,
        eventCount: 1,
        data: { events: [e3] },
      },
      {
        kind: "insert",
        localIndex: 2,
        component: GROUP_COMPONENT,
        firstOffset: 4,
        lastOffset: 4,
        eventCount: 1,
        data: groupFeedData(DEBUG, [e4]),
      },
    ]);
    expect(endState).toEqual({
      open: {
        localIndex: 2,
        firstOffset: 4,
        lastOffset: 4,
        eventCount: 1,
        eventType: DEBUG,
        events: [e4],
      },
      nextLocalIndex: 3,
    });
  });

  it("extends a group that was opened in a previous batch (UPDATE, not a new row)", () => {
    const e1 = event(1, DEBUG);
    const e2 = event(2, DEBUG);
    const first = planFeedOps(INITIAL_FEED_STATE, [e1]);
    const second = planFeedOps(first.endState, [e2]);
    expect(second.ops).toEqual([
      {
        kind: "update",
        localIndex: 0,
        lastOffset: 2,
        eventCount: 2,
        data: groupFeedData(DEBUG, [e1, e2]),
      },
    ]);
    expect(second.endState.open?.localIndex).toBe(0);
    expect(second.endState.open?.events).toEqual([e1, e2]);
  });

  it("is deterministic: replaying the same events from the same state yields identical ops", () => {
    const events = [event(1, CREATED), event(2, WOKEN), event(3, DEBUG), event(4, DEBUG)];
    expect(planFeedOps(INITIAL_FEED_STATE, events)).toEqual(
      planFeedOps(INITIAL_FEED_STATE, events),
    );
  });

  it("emits exactly one op per group for a large same-type batch (no O(n²) write amplification)", () => {
    const events = Array.from({ length: MAX_GROUP_EVENTS }, (_, i) => event(i + 1, DEBUG));
    const { ops, endState } = planFeedOps(INITIAL_FEED_STATE, events);
    // A run that stays within one group row produces a single statement carrying
    // the whole accumulated event list, not one op per event.
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      kind: "insert",
      localIndex: 0,
      component: GROUP_COMPONENT,
      firstOffset: 1,
      lastOffset: MAX_GROUP_EVENTS,
      eventCount: MAX_GROUP_EVENTS,
      data: groupFeedData(DEBUG, events),
    });
    expect(endState.open?.eventCount).toBe(MAX_GROUP_EVENTS);
    expect(endState.nextLocalIndex).toBe(1);
  });

  it("rolls a same-type run over into a new group once it hits MAX_GROUP_EVENTS", () => {
    const total = MAX_GROUP_EVENTS * 2 + 5;
    const events = Array.from({ length: total }, (_, i) => event(i + 1, DEBUG));
    const { ops, endState } = planFeedOps(INITIAL_FEED_STATE, events);
    // One coalesced op per bounded group: two full groups plus a partial third.
    expect(ops).toHaveLength(3);
    expect(ops.map((op) => op.localIndex)).toEqual([0, 1, 2]);
    expect(ops.map((op) => op.eventCount)).toEqual([MAX_GROUP_EVENTS, MAX_GROUP_EVENTS, 5]);
    // No group exceeds the bound, and offsets stay contiguous across the rollover.
    // A fresh batch from the initial state opens every group here, so all ops insert.
    expect(ops.every((op) => op.kind === "insert")).toBe(true);
    expect(ops[0].lastOffset).toBe(MAX_GROUP_EVENTS);
    expect(ops[1].kind === "insert" && ops[1].firstOffset).toBe(MAX_GROUP_EVENTS + 1);
    expect(endState.open?.eventCount).toBe(5);
    expect(endState.nextLocalIndex).toBe(3);
  });

  it("the size-bounded rollover folds identically event-by-event and whole-batch", () => {
    const total = MAX_GROUP_EVENTS + 3;
    const events = Array.from({ length: total }, (_, i) => event(i + 1, DEBUG));
    let perEvent = INITIAL_FEED_STATE;
    for (const e of events) perEvent = planFeedOps(perEvent, [e]).endState;
    expect(perEvent).toEqual(planFeedOps(INITIAL_FEED_STATE, events).endState);
  });

  it("folding one event at a time matches folding the whole batch (reduce vs afterAppendBatch)", () => {
    const events = [
      event(1, CREATED),
      event(2, WOKEN),
      event(3, DEBUG),
      event(4, DEBUG),
      event(5, WOKEN),
      event(6, DEBUG),
    ];
    let perEvent = INITIAL_FEED_STATE;
    for (const e of events) perEvent = planFeedOps(perEvent, [e]).endState;
    expect(perEvent).toEqual(planFeedOps(INITIAL_FEED_STATE, events).endState);
  });
});
