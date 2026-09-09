import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import type { StreamEvent } from "iterate/processors";
import { makeMemoryProgressStore, makeProcessorHarness } from "iterate/processors/testing";
import {
  FEED_ITEM_PUBLISHED,
  FeedItemPublication,
  FeedProcessorContract,
} from "./feed-contract.ts";
import { createFeedPublicationStore, FeedProcessor, reduceFeed } from "./feed-processor.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function publicationStore() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  // This adapter implements the only SqlStorage surface the publication index uses.
  const sql = {
    exec<T>(statement: string, ...params: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...params);
      // SqlStorage.exec<T> gives its caller the same row-shape assertion.
      return { toArray: () => rows as T[] };
    },
  } as SqlStorage;
  return createFeedPublicationStore(sql);
}

function userMessage(text = "hello") {
  return {
    type: "events.iterate.com/agents/context-added",
    payload: { role: "user", actor: { type: "user", origin: "web" }, content: text },
  };
}

function createHarness() {
  const publications = publicationStore();
  const refreshLive = vi.fn();
  const harness = makeProcessorHarness<FeedProcessorContract, FeedProcessor>({
    createProcessor: (deps) => new FeedProcessor({ ...deps, publications, refreshLive }),
  });
  return { harness, publications, refreshLive };
}

function event(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return {
    offset,
    type,
    payload,
    path: "/harness/processor",
    createdAt: new Date(offset * 1000).toISOString(),
  };
}

describe("server feed publications", () => {
  it("drops the publication index when the source is replaced, allowing lower offsets and reused IDs", async () => {
    const { harness, publications } = createHarness();
    await harness.stream.append(userMessage("lifetime A"));
    await harness.settle();
    const prior = publications.get("user-1")!;
    publications.save({ ...prior, firstOffset: 50, revisionOffset: 100 }, 101);
    harness.processor().resetForStream();
    expect(publications.get("user-1")).toBeUndefined();
    publications.save(prior, 2);
    expect(publications.get("user-1")).toEqual(prior);
  });

  it("publishes a complete immutable message and does not recursively publish its own output", async () => {
    const { harness } = createHarness();
    await harness.stream.append(userMessage());
    await harness.settle();
    expect(harness.events(FEED_ITEM_PUBLISHED)).toHaveLength(1);
    expect(
      FeedItemPublication.parse(harness.events(FEED_ITEM_PUBLISHED)[0]!.payload),
    ).toMatchObject({
      item: { kind: "user", id: "user-1", text: "hello" },
      firstOffset: 1,
      ordinal: 0,
      revisionOffset: 1,
    });
  });

  it("replays from zero after publication without duplicating events or moving rows", async () => {
    const { harness, publications, refreshLive } = createHarness();
    await harness.stream.append(userMessage());
    await harness.settle();
    const before = structuredClone(harness.events());
    harness.runner().dispose();
    const replay = makeProcessorHarness<FeedProcessorContract, FeedProcessor>({
      substrate: { ...harness.substrate, progress: makeMemoryProgressStore(FeedProcessorContract) },
      createProcessor: (deps) => new FeedProcessor({ ...deps, publications, refreshLive }),
    });
    await replay.settle();
    expect(replay.events()).toEqual(before);
    expect(publications.get("user-1")).toMatchObject({ firstOffset: 1, ordinal: 0 });
  });

  it("publishes late mention resolution as a revision at the original display position", async () => {
    const { harness, publications } = createHarness();
    await harness.stream.append({
      ...userMessage("[@AGENTS.md](mention://config-repo/AGENTS.md)"),
      payload: {
        ...userMessage("[@AGENTS.md](mention://config-repo/AGENTS.md)").payload,
        mentions: [
          {
            id: "config-repo/AGENTS.md",
            type: "repo-file",
            repoPath: "/repos/config",
            path: "AGENTS.md",
          },
        ],
      },
    });
    await harness.settle();
    const [resolution] = await harness.stream.append({
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: "developer",
        actor: { type: "integration", name: "agent-mention-resolver" },
        content: "resolution details",
        mentionResolution: {
          sourceOffset: 1,
          outcomes: [{ status: "binary", mentionIds: ["config-repo/AGENTS.md"] }],
        },
      },
    });
    await harness.settle();
    expect(harness.events(FEED_ITEM_PUBLISHED)).toHaveLength(2);
    expect(publications.get("user-1")).toMatchObject({
      firstOffset: 1,
      ordinal: 0,
      revisionOffset: resolution!.offset,
      item: { id: "user-1", mentionResolutions: { "config-repo/AGENTS.md": { status: "binary" } } },
    });
    const originals = harness.events(FEED_ITEM_PUBLISHED);
    expect(FeedItemPublication.parse(originals[0]!.payload).item).not.toHaveProperty(
      "mentionResolutions",
    );
  });

  it("keeps streamed chunks in server live state, outside durable reduction and publications", async () => {
    const { harness, refreshLive } = createHarness();
    await harness.stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "test/model" },
    });
    await harness.settle();
    const chunk = {
      ...event(2, "events.iterate.com/agent/llm-response-chunks", {
        llmRequestOffset: 1,
        sequence: 0,
        chunks: [{ response: "hello" }],
      }),
      ephemeral: true as const,
    };
    const opened = await harness.runner().openHostedEventBatchCallback(harness.stream.streamId);
    await opened.processEventBatch({
      streamId: harness.stream.streamId,
      events: [chunk],
      scannedAfterOffset: opened.checkpointOffset,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
    });
    expect(harness.processor().presentation(harness.state()).agent.live?.steps[0]).toMatchObject({
      responseText: "hello",
    });
    expect(harness.state().agent.live?.steps[0]).toMatchObject({ responseText: "" });
    expect(harness.events(FEED_ITEM_PUBLISHED)).toHaveLength(0);
    expect(refreshLive).toHaveBeenCalled();
    // A source replacement can keep the same warm facet instance. Clear its
    // volatile overlay before publishing the new lifetime's initial state.
    harness.processor().resetForStream();
    expect(
      harness.processor().presentation(FeedProcessorContract.stateSchema.parse({})).agent.live,
    ).toBeNull();
    const durableState = harness.state();
    harness.crash();
    // A new facet has the durable state but no ephemeral text from its predecessor.
    expect(harness.processor().presentation(durableState).agent.live?.steps[0]).toMatchObject({
      responseText: "",
    });
  });

  it("does not settle a newer request when an older idle transition arrives late", () => {
    const started = reduceFeed(
      FeedProcessorContract.stateSchema.parse({}),
      event(5, "events.iterate.com/agent/llm-request-requested", { model: "test/model" }),
    ).state;
    const late = reduceFeed(
      started,
      event(6, "events.iterate.com/agent/runtime-changed", {
        runtime: ZERO_AGENT_RUNTIME,
        sinceOffset: 4,
        since: new Date(4000).toISOString(),
      }),
    );
    expect(late.items).toEqual([]);
    expect(late.state.agent.live?.steps[0]).toMatchObject({
      llmRequestOffset: 5,
      status: "running",
    });
  });

  it("ignores repeated older runtime transitions", () => {
    const started = reduceFeed(
      FeedProcessorContract.stateSchema.parse({}),
      event(1, "events.iterate.com/agent/llm-request-requested", { model: "test/model" }),
    ).state;
    const settled = reduceFeed(
      started,
      event(3, "events.iterate.com/agent/runtime-changed", {
        runtime: ZERO_AGENT_RUNTIME,
        sinceOffset: 2,
        since: new Date(2000).toISOString(),
      }),
    );
    expect(settled.state.agent.live).toBeNull();
    expect(settled.items).toHaveLength(1);
    expect(
      reduceFeed(
        settled.state,
        event(4, "events.iterate.com/agent/runtime-changed", {
          runtime: ZERO_AGENT_RUNTIME,
          sinceOffset: 2,
          since: new Date(2000).toISOString(),
        }),
      ).items,
    ).toEqual([]);
  });
});
