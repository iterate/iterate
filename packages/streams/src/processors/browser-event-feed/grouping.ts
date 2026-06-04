// Pure grouping logic for the "browser-event-feed" processor.
//
// The Event feed reframes the raw stream as a stream of UI components. Each event
// either has a SPECIFIC RENDERER (a dedicated component for its type) — then it is
// written as its own feed_items row and closes any open group — or it has none, in
// which case it is folded into the current open "group" row when the type matches.
// A new type always starts a fresh group row.
//
// This is deliberately a pure function of (state, events): the reducer uses it to
// advance state, and afterAppendBatch re-folds it over the same batch to derive the
// exact SQLite ops. Same input => same ops => idempotent replay.

import type { StreamEvent } from "../../shared/event.ts";

/** Maps an event type to its specific renderer component, or null to fall into the group. */
export function componentForEventType(type: string): string | null {
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
 * The reducer calls this one event at a time; afterAppendBatch calls it with the whole
 * delivered batch to produce one transaction.
 */
export function planFeedOps(
  start: FeedState,
  events: readonly StreamEvent[],
): { ops: FeedOp[]; endState: FeedState } {
  let open = start.open;
  let nextLocalIndex = start.nextLocalIndex;
  const ops: FeedOp[] = [];

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
      open = null;
      continue;
    }

    if (open !== null && open.eventType === event.type) {
      // Extend the open group for this event type.
      const events = [...open.events, event];
      open = {
        ...open,
        lastOffset: event.offset,
        eventCount: open.eventCount + 1,
        events,
      };
      ops.push({
        kind: "update",
        localIndex: open.localIndex,
        lastOffset: open.lastOffset,
        eventCount: open.eventCount,
        data: groupFeedData(open.eventType, events),
      });
      continue;
    }

    // Start a new group (no open row, or the type changed).
    const events = [event];
    open = {
      localIndex: nextLocalIndex,
      firstOffset: event.offset,
      lastOffset: event.offset,
      eventCount: 1,
      eventType: event.type,
      events,
    };
    nextLocalIndex += 1;
    ops.push({
      kind: "insert",
      localIndex: open.localIndex,
      component: GROUP_COMPONENT,
      firstOffset: open.firstOffset,
      lastOffset: open.lastOffset,
      eventCount: open.eventCount,
      data: groupFeedData(event.type, events),
    });
  }

  return { ops, endState: { open, nextLocalIndex } };
}

export function groupFeedData(eventType: string, events: readonly StreamEvent[]): GroupFeedData {
  return { eventType, events: [...events] };
}

/** Read grouping metadata back out of a feed_items.data blob. */
export function parseGroupFeedData(data: unknown): GroupFeedData | undefined {
  const record = feedDataRecord(data);
  if (record === undefined || typeof record.eventType !== "string") return undefined;
  if (!Array.isArray(record.events)) return { eventType: record.eventType, events: [] };
  const events = record.events.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.offset !== "number" ||
      typeof row.type !== "string" ||
      typeof row.createdAt !== "string"
    ) {
      return [];
    }
    return [
      {
        offset: row.offset,
        type: row.type,
        createdAt: row.createdAt,
        ...(row.payload !== undefined ? { payload: row.payload } : {}),
        ...(row.metadata !== undefined && row.metadata !== null && typeof row.metadata === "object"
          ? { metadata: row.metadata as Record<string, unknown> }
          : {}),
        ...(row.source !== undefined ? { source: row.source as StreamEvent["source"] } : {}),
        ...(typeof row.idempotencyKey === "string" ? { idempotencyKey: row.idempotencyKey } : {}),
      },
    ];
  });
  return { eventType: record.eventType, events };
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
