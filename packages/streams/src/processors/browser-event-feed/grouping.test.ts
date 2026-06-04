import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../shared/event.ts";
import { reduceProcessorEvents } from "../../shared/stream-processors.ts";
import { GROUP_COMPONENT, groupFeedData, INITIAL_FEED_STATE, planFeedOps } from "./grouping.ts";
import { browserEventFeedContract } from "./contract.ts";

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

  it("collapses a run of non-specific events of the same type into one group row that it keeps updating", () => {
    const e1 = event(1, DEBUG);
    const e2 = event(2, DEBUG);
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
        kind: "update",
        localIndex: 0,
        lastOffset: 2,
        eventCount: 2,
        data: groupFeedData(DEBUG, [e1, e2]),
      },
      {
        kind: "update",
        localIndex: 0,
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
        lastOffset: 1,
        eventCount: 1,
        data: groupFeedData(DEBUG, [e1]),
      },
      {
        kind: "update",
        localIndex: 0,
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

  it("the contract reducer advances state via the same grouping", () => {
    const events = [event(1, CREATED), event(2, WOKEN), event(3, DEBUG), event(4, DEBUG)];
    const reduced = reduceProcessorEvents({ contract: browserEventFeedContract, events });
    expect(reduced).toEqual(planFeedOps(INITIAL_FEED_STATE, events).endState);
  });
});
