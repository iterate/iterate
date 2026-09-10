import { DatabaseSync } from "node:sqlite";
import { appendText, sliceText } from "@iterate-com/shared/chunked-text";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import type { StreamEvent } from "iterate/processors";
import { makeMemoryProgressStore, makeProcessorHarness } from "iterate/processors/testing";
import { FeedItemPublication, FeedLiveState, FeedProcessorContract } from "./feed-contract.ts";
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
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .publicationOffset,
    ).toBe(101);
    harness.processor().resetForStream();
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .publicationOffset,
    ).toBe(0);
    expect(publications.get("user-1")).toBeUndefined();
    publications.save(prior, 2);
    expect(publications.get("user-1")).toEqual(prior);
  });

  it("publishes a complete immutable message and does not recursively publish its own output", async () => {
    const { harness } = createHarness();
    await harness.stream.append(userMessage());
    await harness.settle();
    expect(harness.events("events.iterate.com/feed/item-published")).toHaveLength(1);
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .publicationOffset,
    ).toBe(harness.events("events.iterate.com/feed/item-published")[0]!.offset);
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
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .agent!.live?.steps[0],
    ).toMatchObject({
      responseText: appendText("", "hello"),
    });
    expect(harness.state().agent!.live?.steps[0]).toMatchObject({ responseText: "" });
    expect(harness.events("events.iterate.com/feed/item-published")).toHaveLength(0);
    expect(refreshLive).toHaveBeenCalled();
    // A source replacement can keep the same warm facet instance. Clear its
    // volatile overlay before publishing the new lifetime's initial state.
    harness.processor().resetForStream();
    expect(
      harness.processor().presentation(FeedProcessorContract.stateSchema.parse({}), null).agent!
        .live,
    ).toBeNull();
    const durableState = harness.state();
    harness.crash();
    // A new facet has the durable state but no ephemeral text from its predecessor.
    expect(
      harness.processor().presentation(durableState, harness.runner().currentStreamId ?? null)
        .agent!.live?.steps[0],
    ).toMatchObject({
      responseText: "",
    });
  });

  it.each(["response", "thinking", "mixed"])(
    "bounds streamed %s preview without truncating the durable response",
    async (kind) => {
      const { harness } = createHarness();
      await harness.stream.append({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "test/model" },
      });
      await harness.settle();
      const opened = await harness.runner().openHostedEventBatchCallback(harness.stream.streamId);
      const chunkText = "\u0000🦊".repeat(10_000);
      for (let sequence = 0; sequence < 40; sequence++) {
        const [chunk] = await harness.stream.append({
          type: "events.iterate.com/agent/llm-response-chunks",
          payload: {
            llmRequestOffset: 1,
            sequence,
            chunks: [
              {
                delta: {
                  text: kind === "thinking" ? "" : chunkText,
                  thinking: kind === "response" ? "" : chunkText,
                },
              },
            ],
          },
          ephemeral: true,
        });
        await opened.processEventBatch({
          streamId: harness.stream.streamId,
          events: [chunk!],
          scannedAfterOffset: chunk!.offset - 1,
          scannedThroughOffset: chunk!.offset,
          streamMaxOffset: chunk!.offset,
        });
      }
      const live = harness
        .processor()
        .presentation(harness.state(), harness.runner().currentStreamId ?? null);
      expect(new TextEncoder().encode(JSON.stringify(live)).byteLength).toBeLessThan(
        8 * 1024 * 1024,
      );
      expect(live.agent!.live?.steps[0]).toMatchObject({ previewTruncated: true });
      const fullText = chunkText.repeat(40);
      await harness.stream.append({
        type: "events.iterate.com/agents/context-added",
        payload: { role: "assistant", llmRequestOffset: 1, content: fullText },
      });
      await harness.settle();
      expect(harness.state().agent!.live?.steps[0]).toMatchObject({ responseText: fullText });
      expect(harness.state().agent!.live?.steps[0]).not.toHaveProperty("previewTruncated");
      expect(
        new TextEncoder().encode(
          JSON.stringify(
            harness
              .processor()
              .presentation(harness.state(), harness.runner().currentStreamId ?? null),
          ),
        ).byteLength,
      ).toBeLessThan(8 * 1024 * 1024);
      harness.crash();
      await harness.runner().snapshot();
      expect(
        harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
          .agent!.live?.steps[0],
      ).toMatchObject({
        previewTruncated: true,
      });
      await harness.append({
        type: "events.iterate.com/agent/runtime-changed",
        payload: {
          runtime: ZERO_AGENT_RUNTIME,
          sinceOffset: 1,
          since: new Date().toISOString(),
        },
      });
      await harness.settle();
      const publication = FeedItemPublication.parse(
        harness.events("events.iterate.com/feed/item-published").at(-1)!.payload,
      );
      expect(publication.item).toMatchObject({ steps: [{ responseText: fullText }] });
      expect(
        harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
          .agent!.live,
      ).toBeNull();
    },
  );

  it("shares the preview budget across requests and preserves complete Unicode characters", () => {
    const { harness } = createHarness();
    let state = FeedProcessorContract.stateSchema.parse({});
    for (let request = 0; request < 8; request++) {
      const offset = request * 2 + 1;
      state = reduceFeed(
        state,
        event(offset, "events.iterate.com/agent/llm-request-requested", {
          model: "test/model",
        }),
      ).state;
      state = reduceFeed(
        state,
        event(offset + 1, "events.iterate.com/agents/context-added", {
          role: "assistant",
          llmRequestOffset: offset,
          content: "A" + "🦊".repeat(100_000),
        }),
      ).state;
    }
    const live = harness.processor().presentation(state, null).agent!.live!;
    const requests = live.steps.filter((step) => step.kind === "llm");
    expect(requests).toHaveLength(8);
    expect(
      requests.reduce(
        (size, step) => size + step.responseText.length + step.thinkingText.length,
        0,
      ),
    ).toBeLessThanOrEqual(1_048_576);
    expect(requests.at(-1)!.responseText).toBe("A" + "🦊".repeat(100_000));
    expect(requests[0]).toMatchObject({ responseText: "", previewTruncated: true });
    for (const step of requests) {
      expect(sliceText(step.responseText).isWellFormed()).toBe(true);
    }
  });

  it.each(["code", "result", "queued-input"])(
    "explicitly omits oversized %s without changing durable data",
    async (kind) => {
      const { harness } = createHarness();
      const large = "x".repeat(8 * 1024 * 1024);
      await harness.append({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "test/model" },
      });
      if (kind === "queued-input") {
        await harness.append(userMessage(large));
        expect(harness.state().agent.queuedUserMessages[0]?.text).toBe(large);
      } else {
        await harness.append({
          type: "events.iterate.com/capability-host/script-run-requested",
          payload: {
            executionId: "large-preview",
            code: kind === "code" ? large : "return largeResult",
            expiresAt: 2_000_000,
          },
        });
        if (kind === "result") {
          await harness.append({
            type: "events.iterate.com/capability-host/script-run-settled",
            payload: {
              executionId: "large-preview",
              settlement: { status: "succeeded", result: { text: large } },
            },
          });
        }
        expect(harness.state().agent.live?.steps.at(-1)).toMatchObject(
          kind === "code" ? { code: large } : { result: { text: large } },
        );
      }
      const snapshot = harness.processor().presentation(harness.state(), harness.stream.streamId);
      expect(FeedLiveState.parse(snapshot)).toMatchObject({
        streamId: harness.stream.streamId,
        previewStatus: "omitted",
        agent: null,
      });
      expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(1_000);
      await harness.append({
        type: "events.iterate.com/agent/runtime-changed",
        payload: { runtime: ZERO_AGENT_RUNTIME, sinceOffset: 2, since: new Date().toISOString() },
      });
      expect(
        harness.processor().presentation(harness.state(), harness.stream.streamId),
      ).toMatchObject({
        previewStatus: "available",
        agent: { live: null },
      });
      expect(harness.events("events.iterate.com/feed/item-published").length).toBeGreaterThan(0);
    },
  );

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
    expect(late.state.agent!.live?.steps[0]).toMatchObject({
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
    expect(settled.state.agent!.live).toBeNull();
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

  it("publishes a source lifetime only after that lifetime delivers", async () => {
    const { harness } = createHarness();
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .streamId,
    ).toBeNull();

    await harness.append(userMessage("first lifetime"));
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .streamId,
    ).toBe(harness.stream.streamId);

    harness.processor().resetForStream();
    // Resetting the projection does not change its runner checkpoint; it is
    // still a coherent view of the first source lifetime until replacement
    // binds a new checkpoint.
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .streamId,
    ).toBe(harness.stream.streamId);
    const replacementId = crypto.randomUUID();
    harness.stream.streamId = replacementId;
    harness.stream.events = [];
    await harness.runner().openHostedEventBatchCallback(replacementId);
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .streamId,
    ).toBe(replacementId);

    harness.crash();
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .streamId,
    ).toBeNull();
    // The runner reloads through the normal one-way delivery path. The
    // source may be caught up, so that delivery can be an empty batch.
    const revived = await harness.runner().openHostedEventBatchCallback(replacementId);
    await revived.processEventBatch({
      streamId: replacementId,
      events: [],
      scannedAfterOffset: 0,
      scannedThroughOffset: 0,
      streamMaxOffset: 0,
    });
    expect(
      harness.processor().presentation(harness.state(), harness.runner().currentStreamId ?? null)
        .streamId,
    ).toBe(replacementId);
  });
});
