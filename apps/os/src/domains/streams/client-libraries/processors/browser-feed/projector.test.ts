import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import {
  BROWSER_FEED_SCHEMA_VERSION,
  initialBrowserFeedState,
  MAX_GROUP_EVENTS,
  planBrowserFeedOps,
  RAW_GROUP_KIND,
  rawGroupData,
} from "./projector.ts";

function event(offset: number, type: string, payload: unknown = { offset }): StreamEvent {
  return {
    offset,
    type,
    createdAt: new Date(offset * 1000).toISOString(),
    payload,
    path: "/tests/feed",
  } as StreamEvent;
}

const CREATED = "events.iterate.com/stream/created";
const WOKEN = "events.iterate.com/stream/woken";
const DEBUG = "events.iterate.com/debug/random-event";
const CONTEXT_ADDED = "events.iterate.com/agents/context-added";
const WEB_MESSAGE_SENT = "events.iterate.com/agents/web-message-sent";
function userMessage(offset: number, text: string): StreamEvent {
  return event(offset, CONTEXT_ADDED, {
    role: "user",
    actor: { type: "user", origin: "web" },
    content: text,
    llmRequestPolicy: { behaviour: "after-current-request" },
  });
}

const START = initialBrowserFeedState();

describe("browser-feed projector state boundary", () => {
  it("identifies every newly projected state as the current clean-cut schema", () => {
    expect(START.schemaVersion).toBe(BROWSER_FEED_SCHEMA_VERSION);
    expect(planBrowserFeedOps(START, [event(1, DEBUG)]).endState.schemaVersion).toBe(
      BROWSER_FEED_SCHEMA_VERSION,
    );
  });
});

describe("browser-feed projector — raw lens", () => {
  it("writes specific-renderer events as their own raw singleton rows", () => {
    // Offsets 1 and 2 so the agent lens treats the wake as the initial one
    // (no pretty divider) — this test is about the raw lens alone.
    const e1 = event(1, CREATED);
    const e2 = event(2, WOKEN);
    const { ops, endState } = planBrowserFeedOps(START, [e1, e2]);
    expect(ops).toEqual([
      {
        kind: "insert",
        localIndex: 0,
        itemKind: "raw.stream.created",
        firstOffset: 1,
        lastOffset: 1,
        eventCount: 1,
        data: { events: [e1] },
      },
      {
        kind: "insert",
        localIndex: 1,
        itemKind: "raw.stream.woken",
        firstOffset: 2,
        lastOffset: 2,
        eventCount: 1,
        data: { events: [e2] },
      },
    ]);
    expect(endState.open).toBeNull();
    expect(endState.nextLocalIndex).toBe(2);
  });

  it("collapses a run of non-specific events of the same type into ONE coalesced insert op", () => {
    const e1 = event(1, DEBUG);
    const e2 = event(2, DEBUG);
    const e3 = event(3, DEBUG);
    const { ops, endState } = planBrowserFeedOps(START, [e1, e2, e3]);
    // The whole same-type run touches local_index 0 once: a single upsert
    // carrying the final lastOffset/eventCount/data, not one op per event.
    expect(ops).toEqual([
      {
        kind: "insert",
        localIndex: 0,
        itemKind: RAW_GROUP_KIND,
        firstOffset: 1,
        lastOffset: 3,
        eventCount: 3,
        data: rawGroupData(DEBUG, [e1, e2, e3]),
      },
    ]);
    expect(endState.open?.localIndex).toBe(0);
    expect(endState.nextLocalIndex).toBe(1);
  });

  it("starts a new group row when the event type changes", () => {
    const other = "events.iterate.com/debug/other-event";
    const { ops } = planBrowserFeedOps(START, [event(1, DEBUG), event(2, other), event(3, DEBUG)]);
    expect(ops.map((op) => [op.kind, op.localIndex])).toEqual([
      ["insert", 0],
      ["insert", 1],
      ["insert", 2],
    ]);
  });

  it("closes the open group when a specific-renderer event arrives, then opens a fresh group", () => {
    const e1 = event(1, DEBUG);
    const e2 = event(2, DEBUG);
    const e3 = event(3, CREATED);
    const e4 = event(4, DEBUG);
    const { ops, endState } = planBrowserFeedOps(START, [e1, e2, e3, e4]);
    expect(ops).toEqual([
      {
        kind: "insert",
        localIndex: 0,
        itemKind: RAW_GROUP_KIND,
        firstOffset: 1,
        lastOffset: 2,
        eventCount: 2,
        data: rawGroupData(DEBUG, [e1, e2]),
      },
      {
        kind: "insert",
        localIndex: 1,
        itemKind: "raw.stream.created",
        firstOffset: 3,
        lastOffset: 3,
        eventCount: 1,
        data: { events: [e3] },
      },
      {
        kind: "insert",
        localIndex: 2,
        itemKind: RAW_GROUP_KIND,
        firstOffset: 4,
        lastOffset: 4,
        eventCount: 1,
        data: rawGroupData(DEBUG, [e4]),
      },
    ]);
    expect(endState.open?.localIndex).toBe(2);
  });

  it("extends a group that was opened in a previous batch (UPDATE, not a new row)", () => {
    const e1 = event(1, DEBUG);
    const e2 = event(2, DEBUG);
    const first = planBrowserFeedOps(START, [e1]);
    const second = planBrowserFeedOps(first.endState, [e2]);
    expect(second.ops).toEqual([
      {
        kind: "update",
        localIndex: 0,
        lastOffset: 2,
        eventCount: 2,
        data: rawGroupData(DEBUG, [e1, e2]),
      },
    ]);
    expect(second.endState.open?.localIndex).toBe(0);
  });

  it("rolls a same-type run over into a new group once it hits MAX_GROUP_EVENTS", () => {
    const total = MAX_GROUP_EVENTS * 2 + 5;
    const events = Array.from({ length: total }, (_, i) => event(i + 1, DEBUG));
    const { ops, endState } = planBrowserFeedOps(START, events);
    // One coalesced op per bounded group: two full groups plus a partial third.
    expect(ops).toHaveLength(3);
    expect(ops.map((op) => op.localIndex)).toEqual([0, 1, 2]);
    expect(ops.map((op) => ("eventCount" in op ? op.eventCount : null))).toEqual([
      MAX_GROUP_EVENTS,
      MAX_GROUP_EVENTS,
      5,
    ]);
    expect(endState.open?.eventCount).toBe(5);
    expect(endState.nextLocalIndex).toBe(3);
  });
});

describe("browser-feed projector — one interleaved order", () => {
  it("allocates pretty and raw rows from ONE counter, pretty row first for its event", () => {
    const message = userMessage(3, "hello");
    const { ops } = planBrowserFeedOps(START, [event(1, CREATED), event(2, WOKEN), message]);
    expect(ops.map((op) => [op.localIndex, op.kind === "insert" ? op.itemKind : "update"])).toEqual(
      [
        [0, "raw.stream.created"],
        [1, "raw.stream.woken"],
        // The message event settles the user bubble first, then lands in a
        // fresh raw group — adjacent rows, one order, no view-side stitching.
        [2, "agent.user"],
        [3, RAW_GROUP_KIND],
      ],
    );
  });

  it("a pretty row settled mid-run does NOT close the open raw group (update in place)", () => {
    const m1 = userMessage(1, "first");
    const m2 = userMessage(2, "second");
    const { ops, endState } = planBrowserFeedOps(START, [m1, m2]);
    // m1: bubble@0 + group insert@1. m2: bubble@2 + the SAME group row@1
    // extends in place (coalesced into its insert op), keeping local_index 1.
    expect(ops).toEqual([
      expect.objectContaining({ localIndex: 0, itemKind: "agent.user" }),
      expect.objectContaining({
        localIndex: 1,
        itemKind: RAW_GROUP_KIND,
        firstOffset: 1,
        lastOffset: 2,
        eventCount: 2,
      }),
      expect.objectContaining({ localIndex: 2, itemKind: "agent.user" }),
    ]);
    expect(endState.open?.localIndex).toBe(1);
    expect(endState.nextLocalIndex).toBe(3);
  });

  it("settles assistant bubbles and wake dividers as agent.* rows alongside their raw rows", () => {
    const sent = event(3, WEB_MESSAGE_SENT, { message: "hi there" });
    const woken = event(4, WOKEN);
    const { ops } = planBrowserFeedOps(START, [event(1, CREATED), event(2, WOKEN), sent, woken]);
    const kinds = ops.map((op) => (op.kind === "insert" ? op.itemKind : "update"));
    expect(kinds).toEqual([
      "raw.stream.created",
      "raw.stream.woken",
      "agent.assistant",
      RAW_GROUP_KIND,
      // A non-initial wake renders both ways: quiet pretty divider + raw row.
      "agent.stream-woken",
      "raw.stream.woken",
    ]);
  });

  it("collapses consecutive pretty stream wakes into the final wake with a count", () => {
    const { ops, endState } = planBrowserFeedOps(START, [
      event(1, CREATED),
      event(2, WOKEN),
      event(3, WOKEN),
      event(4, WOKEN),
      userMessage(5, "wake boundary"),
      event(6, WOKEN),
      event(7, WOKEN),
    ]);
    const agentOps = ops.filter(
      (op) => op.kind === "replace" || (op.kind === "insert" && op.itemKind.startsWith("agent.")),
    );

    expect(agentOps).toMatchObject([
      { kind: "insert", localIndex: 2, data: { kind: "stream-woken", id: "stream-woken-3" } },
      {
        kind: "replace",
        localIndex: 2,
        data: { kind: "stream-woken", id: "stream-woken-4", count: 2 },
      },
      { kind: "insert", localIndex: 5, data: { kind: "user", id: "user-5" } },
      { kind: "insert", localIndex: 7, data: { kind: "stream-woken", id: "stream-woken-6" } },
      {
        kind: "replace",
        localIndex: 7,
        data: { kind: "stream-woken", id: "stream-woken-7", count: 2 },
      },
    ]);
    expect(endState.nextLocalIndex).toBe(10);
  });

  it("does not retain replacement indexes for ordinary settled feed items", () => {
    const projected = planBrowserFeedOps(START, [
      userMessage(1, "hello"),
      event(2, WEB_MESSAGE_SENT, { message: "hi" }),
    ]);

    expect(projected.endState.replaceableAgentItemIndexes).toEqual({});
  });

  it("replaces a linked-attachment message when its durable outcome arrives", () => {
    const attachments = [
      {
        id: "config-repo/AGENTS.md",
        type: "repo-file",
        repoPath: "/repos/config",
        path: "AGENTS.md",
      },
    ];
    const source = event(1, CONTEXT_ADDED, {
      role: "user",
      actor: { type: "user", origin: "web" },
      content: "[@AGENTS.md](attachment:config-repo/AGENTS.md)",
      attachments,
    });
    const resolution = event(2, CONTEXT_ADDED, {
      role: "developer",
      actor: { type: "integration", name: "agent-reference-resolver" },
      content: "resolution details",
      referenceResolution: {
        sourceOffset: 1,
        outcomes: [{ status: "binary", attachmentIds: ["config-repo/AGENTS.md"] }],
      },
    });

    const projected = planBrowserFeedOps(START, [source, resolution]);
    const agentOps = projected.ops.filter(
      (op) => op.kind === "replace" || (op.kind === "insert" && op.itemKind === "agent.user"),
    );
    expect(agentOps).toMatchObject([
      { kind: "insert", localIndex: 0, data: { id: "user-1", attachments } },
      {
        kind: "replace",
        localIndex: 0,
        data: {
          id: "user-1",
          attachments,
          referenceResolutions: { "config-repo/AGENTS.md": { status: "binary" } },
        },
      },
    ]);
    expect(projected.endState.agent.pendingReferenceMessages).toEqual({});
    expect(projected.endState.replaceableAgentItemIndexes).toEqual({});
  });

  it("is deterministic and folds identically event-by-event and whole-batch", () => {
    const events = [
      event(1, CREATED),
      event(2, WOKEN),
      userMessage(3, "hello"),
      event(4, DEBUG),
      event(5, DEBUG),
      event(6, WEB_MESSAGE_SENT, { message: "reply" }),
      event(7, WOKEN),
    ];
    expect(planBrowserFeedOps(START, events)).toEqual(planBrowserFeedOps(START, events));
    let perEvent = START;
    for (const e of events) perEvent = planBrowserFeedOps(perEvent, [e]).endState;
    expect(perEvent).toEqual(planBrowserFeedOps(START, events).endState);
  });
});
