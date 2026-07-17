// Pure projection logic for the "browser-feed" processor: ONE feed item
// abstraction for everything the stream feed renders.
//
// Every event is folded through two lenses in a fixed order, drawing list
// positions from a single monotonic counter, so `feed_items.local_index` is
// the total feed order — pretty chat rows and raw debug rows interleave in
// one list, and the React view renders `ORDER BY local_index` instead of
// stitching two tables together:
//
//   1. The AGENT lens (packages/ui agent-ui-reducer) may settle zero or more
//      chat items — user/assistant bubbles, archived activities, wake/pause
//      dividers — each written as a `agent.<kind>` row. In-flight work stays
//      in reduced state (the live tail renders straight from it).
//   2. The RAW lens groups the event into `raw.*` rows: types with a specific
//      renderer become their own `raw.<component>` singleton row; everything
//      else folds into the current open `raw.group` row while the type
//      matches. Group rows update IN PLACE — later same-type events extend
//      `last_offset`/`event_count`/`data` but the row keeps its original
//      `local_index`, so a pretty row emitted mid-run does not split the
//      group. Interleaving is at feed-item granularity, not per event.
//
// This is deliberately a pure function of (state, events): the reducer uses
// it to advance state, and processEventBatch re-folds it over the same batch
// to derive the exact SQLite ops. Same input => same ops => idempotent replay.

import {
  initialAgentUiState,
  isCurrentAgentUiState,
  reduceAgentUi,
  type AgentUiItem,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamEvent } from "iterate/processors";

/** Kind prefix for pretty chat rows settled by the agent lens. */
export const AGENT_KIND_PREFIX = "agent.";
/** Kind prefix for raw rows (grouped runs and specific-renderer singletons). */
export const RAW_KIND_PREFIX = "raw.";
/** Kind of the catch-all grouped raw row. */
export const RAW_GROUP_KIND = "raw.group";

/**
 * Clean-cut identity for persisted browser-feed reducer state. Old snapshots
 * are disposable caches and must be rebuilt, never interpreted as current
 * state (in particular, they may contain historical ephemeral activity).
 */
export const BROWSER_FEED_SCHEMA_VERSION = 4;
export { isAgentActivity } from "@iterate-com/ui/components/events/agent-ui-reducer";

/** Maps an event type to its specific raw renderer kind, or null to fall into the group. */
function rawSingletonKind(type: string): string | null {
  switch (type) {
    case "events.iterate.com/stream/created":
      return "raw.stream.created";
    case "events.iterate.com/stream/woken":
      return "raw.stream.woken";
    case "events.iterate.com/stream/child-stream-created":
      return "raw.stream.child-stream-created";
    default:
      return null;
  }
}

/**
 * Upper bound on events folded into a single raw group row. When an open
 * group reaches this many events, the next same-type event starts a fresh
 * group instead of extending it — bounding both the `feed_items.data` blob
 * size and the per-batch serialization work for streams dominated by one
 * event type.
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

export type RawGroupData = {
  eventType: string;
  events: StreamEvent[];
};

export type RawSingletonData = {
  events: StreamEvent[];
};

/** What a `raw.*` feed_items row stores in `data`. `agent.*` rows store the AgentUiItem. */
export type RawFeedItemData = RawGroupData | RawSingletonData;

export type BrowserFeedState = {
  schemaVersion: typeof BROWSER_FEED_SCHEMA_VERSION;
  /** Agent lens reduced state: live activity, queued messages, presence, token usage. */
  agent: AgentUiState;
  /** The current open, extendable raw group row, or null when closed. */
  open: OpenGroup | null;
  /** Monotonically increasing next feed_items local_index — THE total feed order. */
  nextLocalIndex: number;
  /**
   * Stable row addresses only for activities still awaiting a durable script
   * correction. Ordinary feed items never need replacement, so retaining an
   * index for every message would make the processor snapshot grow with the
   * entire stream a second time.
   */
  provisionalAgentItemIndexes: Record<string, number>;
};

export function initialBrowserFeedState(): BrowserFeedState {
  return {
    schemaVersion: BROWSER_FEED_SCHEMA_VERSION,
    agent: initialAgentUiState(),
    open: null,
    nextLocalIndex: 0,
    provisionalAgentItemIndexes: {},
  };
}

export type FeedOp =
  | {
      kind: "insert";
      localIndex: number;
      itemKind: string;
      firstOffset: number;
      lastOffset: number;
      eventCount: number;
      data: AgentUiItem | RawFeedItemData;
    }
  | {
      kind: "update";
      localIndex: number;
      lastOffset: number;
      eventCount: number;
      data: RawGroupData;
    }
  | {
      kind: "replace";
      localIndex: number;
      itemKind: string;
      lastOffset: number;
      data: AgentUiItem;
    };

/**
 * Fold a batch of events into feed ops + the resulting state, starting from
 * `start`. The reducer calls this one event at a time (and uses only
 * `endState`); processEventBatch calls it with the whole delivered batch to
 * produce one transaction.
 *
 * Raw group ops are coalesced per `local_index`: a run of same-type events
 * that all land in the same group row emits ONE op carrying that row's final
 * `data`/`lastOffset`/`eventCount`. Since the processor upserts on
 * conflict(local_index), a single statement per touched row is correct for
 * both freshly inserted rows and rows replayed over an existing
 * (previous-batch) row. This keeps the batch O(events) in serialization work.
 */
export function planBrowserFeedOps(
  start: BrowserFeedState,
  events: readonly StreamEvent[],
): { ops: FeedOp[]; endState: BrowserFeedState } {
  let agent = start.agent;
  let open = start.open;
  let nextLocalIndex = start.nextLocalIndex;
  const provisionalAgentItemIndexes = { ...start.provisionalAgentItemIndexes };
  const ops: FeedOp[] = [];
  // The op for the row `open` points at, when that row is being mutated within
  // this batch — so we update it in place instead of pushing a fresh op per event.
  let openOp: FeedOp | null = null;

  for (const event of events) {
    // 1. Agent lens first: a settled chat item reads as the cause of the raw
    // detail that follows it, so for a single event the pretty row sits above
    // the raw row that carries the same offset. (The cast bridges to
    // packages/ui's shared Event type until the ui package moves to the itx
    // event model.)
    const settled = reduceAgentUi(agent, event as unknown as Parameters<typeof reduceAgentUi>[1]);
    agent = settled.endState;
    for (const item of settled.items) {
      const existingIndex = provisionalAgentItemIndexes[item.id];
      if (existingIndex !== undefined) {
        ops.push({
          kind: "replace",
          localIndex: existingIndex,
          itemKind: `${AGENT_KIND_PREFIX}${item.kind}`,
          lastOffset: event.offset,
          data: item,
        });
        if (!hasInferredScriptOutcome(item)) delete provisionalAgentItemIndexes[item.id];
        continue;
      }
      ops.push({
        kind: "insert",
        localIndex: nextLocalIndex,
        itemKind: `${AGENT_KIND_PREFIX}${item.kind}`,
        firstOffset: event.offset,
        lastOffset: event.offset,
        eventCount: 1,
        data: item,
      });
      if (hasInferredScriptOutcome(item)) {
        provisionalAgentItemIndexes[item.id] = nextLocalIndex;
      }
      nextLocalIndex += 1;
    }

    // 2. Raw lens: every event lands in exactly one raw row.
    const singleton = rawSingletonKind(event.type);
    if (singleton !== null) {
      // Specific renderer: its own singleton row, and it closes any open group.
      ops.push({
        kind: "insert",
        localIndex: nextLocalIndex,
        itemKind: singleton,
        firstOffset: event.offset,
        lastOffset: event.offset,
        eventCount: 1,
        data: { events: [event] },
      });
      nextLocalIndex += 1;
      open = null;
      openOp = null;
      continue;
    }

    if (open !== null && open.eventType === event.type && open.eventCount < MAX_GROUP_EVENTS) {
      // Extend the open group for this event type (still under the size
      // bound). Pretty rows settled since the group opened do NOT close it —
      // the group keeps its original local_index and grows in place.
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
          data: rawGroupData(open.eventType, groupEvents),
        };
        ops.push(openOp);
      } else {
        // A row inserted/updated earlier in this batch: fold the new event into
        // its existing op so the row still produces exactly one statement.
        openOp.lastOffset = open.lastOffset;
        openOp.eventCount = open.eventCount;
        openOp.data = rawGroupData(open.eventType, groupEvents);
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
      itemKind: RAW_GROUP_KIND,
      firstOffset: open.firstOffset,
      lastOffset: open.lastOffset,
      eventCount: open.eventCount,
      data: rawGroupData(event.type, groupEvents),
    };
    ops.push(openOp);
  }

  return {
    ops,
    endState: {
      schemaVersion: BROWSER_FEED_SCHEMA_VERSION,
      agent,
      open,
      nextLocalIndex,
      provisionalAgentItemIndexes: retainCurrentProvisionalIndexes(
        provisionalAgentItemIndexes,
        agent,
      ),
    },
  };
}

/** Rejects old/partial snapshots. They are cache data, not an API to migrate. */
export function isCurrentBrowserFeedState(value: unknown): value is BrowserFeedState {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<BrowserFeedState>;
  if (!isCurrentAgentUiState(candidate.agent)) return false;
  if (!isOpenGroup(candidate.open)) return false;
  if (!isNonNegativeSafeInteger(candidate.nextLocalIndex)) return false;
  if (!isRecord(candidate.provisionalAgentItemIndexes)) return false;
  const agent = candidate.agent;
  const nextLocalIndex = candidate.nextLocalIndex;
  if (
    !Object.entries(candidate.provisionalAgentItemIndexes).every(
      ([id, index]) =>
        id.length > 0 &&
        isNonNegativeSafeInteger(index) &&
        index < nextLocalIndex &&
        Object.hasOwn(agent.provisionalActivities, id),
    )
  ) {
    return false;
  }
  return (
    candidate.schemaVersion === BROWSER_FEED_SCHEMA_VERSION &&
    (candidate.open === null || candidate.open.localIndex < nextLocalIndex)
  );
}

function isOpenGroup(value: unknown): value is OpenGroup | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const events = value.events;
  if (!Array.isArray(events)) return false;
  return (
    isNonNegativeSafeInteger(value.localIndex) &&
    isNonNegativeSafeInteger(value.firstOffset) &&
    isNonNegativeSafeInteger(value.lastOffset) &&
    value.firstOffset <= value.lastOffset &&
    isNonNegativeSafeInteger(value.eventCount) &&
    value.eventCount > 0 &&
    value.eventCount <= MAX_GROUP_EVENTS &&
    typeof value.eventType === "string" &&
    value.eventType.length > 0 &&
    events.length === value.eventCount &&
    events.every(
      (event, index) =>
        isRecord(event) &&
        event.type === value.eventType &&
        isNonNegativeSafeInteger(event.offset) &&
        (index === 0 ||
          (isRecord(events[index - 1]) &&
            isNonNegativeSafeInteger(events[index - 1].offset) &&
            event.offset > events[index - 1].offset)),
    ) &&
    events[0]?.offset === value.firstOffset &&
    events.at(-1)?.offset === value.lastOffset
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function retainCurrentProvisionalIndexes(
  indexes: Record<string, number>,
  agent: AgentUiState,
): Record<string, number> {
  const retained: Record<string, number> = {};
  for (const id of Object.keys(agent.provisionalActivities)) {
    const index = indexes[id];
    if (index !== undefined) retained[id] = index;
  }
  return retained;
}

function hasInferredScriptOutcome(item: AgentUiItem): boolean {
  return (
    item.kind === "activity" &&
    item.steps.some((step) => step.kind === "code" && step.outcomeSource === "inferred")
  );
}

export function rawGroupData(eventType: string, events: readonly StreamEvent[]): RawGroupData {
  return { eventType, events: [...events] };
}
