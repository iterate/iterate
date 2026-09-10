import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import type { StreamEvent } from "iterate/processors";
import { makeMemoryProgressStore, makeProcessorHarness } from "iterate/processors/testing";
import { FeedItemPublication } from "@iterate-com/ui/components/events/feed-publication";
import { FeedProcessorContract } from "./feed-contract.ts";
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
    expect(harness.processor().presentation(harness.state()).publicationOffset).toBe(101);
    harness.processor().resetForStream();
    expect(harness.processor().presentation(harness.state()).publicationOffset).toBe(0);
    expect(publications.get("user-1")).toBeUndefined();
    publications.save(prior, 2);
    expect(publications.get("user-1")).toEqual(prior);
  });

  it("publishes a complete immutable message and does not recursively publish its own output", async () => {
    const { harness } = createHarness();
    await harness.stream.append(userMessage());
    await harness.settle();
    expect(harness.events("events.iterate.com/feed/item-published")).toHaveLength(1);
    expect(harness.processor().presentation(harness.state()).publicationOffset).toBe(
      harness.events("events.iterate.com/feed/item-published")[0]!.offset,
    );
    expect(
      FeedItemPublication.parse(
        harness.events("events.iterate.com/feed/item-published")[0]!.payload,
      ),
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

  it("recovers the publication index after eviction following append but before index save", async () => {
    const publications = publicationStore();
    const save = publications.save;
    publications.save = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("evicted before index save");
      })
      .mockImplementation(save);
    const harness = makeProcessorHarness<FeedProcessorContract, FeedProcessor>({
      createProcessor: (deps) =>
        new FeedProcessor({ ...deps, publications, refreshLive: () => {} }),
    });
    await harness.stream.append(userMessage());
    await expect(harness.settle()).rejects.toThrow("evicted before index save");
    expect(
      harness
        .events("events.iterate.com/feed/item-published")
        .map((event) => FeedItemPublication.parse(event.payload).item.id),
    ).toEqual(["user-1"]);
    harness.crash();
    await harness.settle();
    await harness.advanceTime(60_000);
    expect(
      harness
        .events("events.iterate.com/feed/item-published")
        .map((event) => FeedItemPublication.parse(event.payload).item.id),
    ).toEqual(["user-1", "processor-revived-3"]);
    expect(publications.get("user-1")).toMatchObject({ firstOffset: 1, revisionOffset: 1 });
  });

  it("finds and corrects an inferred activity after it leaves the reducer's bounded state", async () => {
    const { harness, publications } = createHarness();
    const started = reduceFeed(
      FeedProcessorContract.stateSchema.parse({}),
      event(10, "events.iterate.com/capability-host/script-run-requested", {
        executionId: "late-script",
        code: "return 1",
        expiresAt: 20_000,
      }),
    ).state;
    const inferred = reduceFeed(
      started,
      event(11, "events.iterate.com/agent/runtime-changed", {
        runtime: ZERO_AGENT_RUNTIME,
        sinceOffset: 10,
        since: new Date(11_000).toISOString(),
      }),
    ).items[0]!;
    publications.save({ item: inferred, firstOffset: 1, ordinal: 0, revisionOffset: 1 }, 2);
    // The fresh harness has no provisional activity: only the SQL lookup can find it.
    await harness.stream.append(userMessage());
    await harness.settle();
    const [settlement] = await harness.stream.append({
      type: "events.iterate.com/capability-host/script-run-settled",
      payload: {
        executionId: "late-script",
        settlement: { status: "succeeded", result: { committed: true } },
      },
    });
    await harness.settle();
    expect(publications.get(inferred.id)).toMatchObject({
      firstOffset: 1,
      ordinal: 0,
      revisionOffset: settlement!.offset,
      item: {
        steps: [
          {
            executionId: "late-script",
            outcomeSource: "durable",
            success: true,
            result: { committed: true },
          },
        ],
      },
    });
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
    expect(harness.events("events.iterate.com/feed/item-published")).toHaveLength(2);
    expect(publications.get("user-1")).toMatchObject({
      firstOffset: 1,
      ordinal: 0,
      revisionOffset: resolution!.offset,
      item: { id: "user-1", mentionResolutions: { "config-repo/AGENTS.md": { status: "binary" } } },
    });
    const originals = harness.events("events.iterate.com/feed/item-published");
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
    expect(harness.events("events.iterate.com/feed/item-published")).toHaveLength(0);
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
