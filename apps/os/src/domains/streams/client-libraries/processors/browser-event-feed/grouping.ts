// Pure grouping logic for the "browser-event-feed" processor.
//
// The Event feed reframes the raw stream as a stream of UI components. Each event
// either has a SPECIFIC RENDERER (a dedicated component for its type) — then it is
// written as its own feed_items row and closes any open group — or it has none, in
// which case it is folded into the current open "group" row when the type matches.
// A new type always starts a fresh group row.
//
// This is deliberately a pure function of (state, events): the reducer uses it to
// advance state, and processEventBatch re-folds it over the same batch to derive the
// exact SQLite ops. Same input => same ops => idempotent replay.

import type { StreamEvent } from "../../../../../types.ts";

/** Maps an event type to its specific renderer component, or null to fall into the group. */
function componentForEventType(type: string): string | null {
  switch (type) {
    case "events.iterate.com/stream/created":
      return "stream.created";
    case "events.iterate.com/stream/woken":
      return "stream.woken";
    case "events.iterate.com/stream/child-stream-created":
      return "stream.child-stream-created";
    default:
      return null;
  }
}

/** Component name used for the catch-all group row. */
export const GROUP_COMPONENT = "group";

/**
 * Upper bound on events folded into a single group row. When an open group
 * reaches this many events, the next same-type event starts a fresh group
 * instead of extending it — bounding both the `feed_items.data` blob size and
 * the per-batch serialization work for streams dominated by one event type.
 */
export const MAX_GROUP_EVENTS = 200;

export type OpenGroup = {
  localIndex: number;
  firstOffset: number;
  lastOffset: number;
  eventCount: number;
  eventType: string;
  /** Full committed events in this group row, in offset order. */
  events: StreamEvent[];
};

export type GroupFeedData = {
  eventType: string;
  events: StreamEvent[];
};

export type SingletonFeedData = {
  events: StreamEvent[];
};

export type FeedItemData = GroupFeedData | SingletonFeedData;

export type FeedState = {
  /** The current open, extendable group row, or null when the last row is a singleton. */
  open: OpenGroup | null;
  /** Dense, monotonically increasing next feed_items local_index. */
  nextLocalIndex: number;
};

export const INITIAL_FEED_STATE: FeedState = { open: null, nextLocalIndex: 0 };

export type FeedOp =
  | {
      kind: "insert";
      localIndex: number;
      component: string;
      firstOffset: number;
      lastOffset: number;
      eventCount: number;
      data: FeedItemData;
    }
  | {
      kind: "update";
      localIndex: number;
      lastOffset: number;
      eventCount: number;
      data: GroupFeedData;
    };

/**
 * Fold a batch of events into feed ops + the resulting state, starting from `start`.
 * The reducer calls this one event at a time (and uses only `endState`); processEventBatch
 * calls it with the whole delivered batch to produce one transaction.
 *
 * Ops are coalesced per `local_index`: a run of same-type events that all land in the
 * same group row emits ONE op carrying that row's final `data`/`lastOffset`/`eventCount`,
 * instead of one cumulative op per event. Since `feedOpToStatement` upserts on
 * conflict(local_index), a single statement per touched row is correct for both freshly
 * inserted rows and rows replayed over an existing (previous-batch) row. This keeps the
 * batch O(events) instead of O(events²) in serialization work.
 */
export function planFeedOps(
  start: FeedState,
  events: readonly StreamEvent[],
): { ops: FeedOp[]; endState: FeedState } {
  let open = start.open;
  let nextLocalIndex = start.nextLocalIndex;
  const ops: FeedOp[] = [];
  // The op for the row `open` points at, when that row is being mutated within
  // this batch — so we update it in place instead of pushing a fresh op per event.
  let openOp: FeedOp | null = null;

  const closeOpenOp = () => {
    open = null;
    openOp = null;
  };

  for (const event of events) {
    const renderer = componentForEventType(event.type);

    if (renderer !== null) {
      // Specific renderer: its own singleton row, and it closes any open group.
      ops.push({
        kind: "insert",
        localIndex: nextLocalIndex,
        component: renderer,
        firstOffset: event.offset,
        lastOffset: event.offset,
        eventCount: 1,
        data: { events: [event] },
      });
      nextLocalIndex += 1;
      closeOpenOp();
      continue;
    }

    if (open !== null && open.eventType === event.type && open.eventCount < MAX_GROUP_EVENTS) {
      // Extend the open group for this event type (still under the size bound).
      const groupEvents = [...open.events, event];
      open = {
        ...open,
        lastOffset: event.offset,
        eventCount: open.eventCount + 1,
        events: groupEvents,
      };
      if (openOp === null) {
        // First touch of a row that already existed before this batch: a single
        // UPDATE carrying the final state (kept in sync as more events extend it).
        openOp = {
          kind: "update",
          localIndex: open.localIndex,
          lastOffset: open.lastOffset,
          eventCount: open.eventCount,
          data: groupFeedData(open.eventType, groupEvents),
        };
        ops.push(openOp);
      } else {
        // A row inserted/updated earlier in this batch: fold the new event into
        // its existing op so the row still produces exactly one statement.
        openOp.lastOffset = open.lastOffset;
        openOp.eventCount = open.eventCount;
        openOp.data = groupFeedData(open.eventType, groupEvents);
      }
      continue;
    }

    // Start a new group: no open row, the type changed, or the open group hit
    // MAX_GROUP_EVENTS and must roll over into a fresh row.
    const groupEvents = [event];
    open = {
      localIndex: nextLocalIndex,
      firstOffset: event.offset,
      lastOffset: event.offset,
      eventCount: 1,
      eventType: event.type,
      events: groupEvents,
    };
    nextLocalIndex += 1;
    openOp = {
      kind: "insert",
      localIndex: open.localIndex,
      component: GROUP_COMPONENT,
      firstOffset: open.firstOffset,
      lastOffset: open.lastOffset,
      eventCount: open.eventCount,
      data: groupFeedData(event.type, groupEvents),
    };
    ops.push(openOp);
  }

  return { ops, endState: { open, nextLocalIndex } };
}

export function groupFeedData(eventType: string, events: readonly StreamEvent[]): GroupFeedData {
  return { eventType, events: [...events] };
}

function feedDataRecord(data: unknown): Record<string, unknown> | undefined {
  if (data === null || typeof data !== "object") {
    if (typeof data !== "string") return undefined;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed === null || typeof parsed !== "object") return undefined;
      return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return data as Record<string, unknown>;
}
