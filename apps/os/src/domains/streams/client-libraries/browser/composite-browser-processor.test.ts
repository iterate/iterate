import { describe, expect, it } from "vitest";
import type { AnyHostedProcessor } from "../../processor-host-capabilities.ts";
import { CompositeBrowserProcessor } from "./composite-browser-processor.ts";

// A minimal AnyHostedProcessor stub: records ingest calls (into a shared order
// log so cross-child ordering is observable), reports a fixed checkpoint offset,
// and can be told to throw on ingest to exercise the fan-out failure path.
function makeChild(
  slug: string,
  offset: number,
  opts: {
    order?: string[];
    throwOnIngest?: boolean;
    isLoaded?: boolean;
    liveAgent?: boolean;
  } = {},
) {
  const ingestArgs: {
    events: readonly { offset: number; ephemeral?: boolean }[];
    streamMaxOffset: number;
  }[] = [];
  const liveIngestArgs: typeof ingestArgs = [];
  let markedLoaded = false;
  const metrics = { tag: slug };
  const processor = {
    contract: {
      slug,
      version: "0.1.0",
      description: `stub ${slug}`,
      consumes: ["*"],
      emits: [],
      events: {},
    },
    subscriberMetrics: {
      report: () => metrics,
      notePingObserved: () => {},
      noteAppendCommitted: () => {},
      clearPendingAppends: () => {},
    },
    currentState: { slug },
    get isLoaded() {
      return opts.isLoaded ?? true;
    },
    async ingest(args: {
      events: readonly { offset: number; ephemeral?: boolean }[];
      streamMaxOffset: number;
    }) {
      opts.order?.push(slug);
      ingestArgs.push(args);
      if (opts.throwOnIngest) throw new Error(`${slug} ingest failed`);
    },
    ...(opts.liveAgent
      ? {
          async ingestLive(args: {
            events: readonly { offset: number; ephemeral?: boolean }[];
            streamMaxOffset: number;
          }) {
            opts.order?.push(`${slug}:live`);
            liveIngestArgs.push(args);
          },
          agentUiState: { live: null },
          clearVolatileState() {},
        }
      : {}),
    async snapshot() {
      return { offset, state: null };
    },
    async getRuntimeState() {
      return { snapshot: { offset, state: null } };
    },
    markLoaded() {
      markedLoaded = true;
    },
    observeStateChanges() {
      return () => {};
    },
  } as unknown as AnyHostedProcessor;
  return {
    child: { slug, processor },
    ingestArgs,
    liveIngestArgs,
    metrics,
    wasMarkedLoaded: () => markedLoaded,
  };
}

const BATCH = { events: [{ offset: 42 }], streamMaxOffset: 42 } as unknown as Parameters<
  AnyHostedProcessor["ingest"]
>[0];

describe("CompositeBrowserProcessor", () => {
  it("requires at least one child", () => {
    expect(() => new CompositeBrowserProcessor([])).toThrow(/at least one child/);
  });

  it("reports the MINIMUM child checkpoint as the replay cursor", async () => {
    const raw = makeChild("browser-raw-events", 5000);
    const feed = makeChild("browser-feed", 0);
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);
    expect((await composite.snapshot()).offset).toBe(0);
    // getRuntimeState carries the same (min) checkpoint.
    expect((await composite.getRuntimeState()).snapshot.offset).toBe(0);
  });

  it("fans a batch out to every child in canonical order (primary first)", async () => {
    const order: string[] = [];
    const raw = makeChild("browser-raw-events", 0, { order });
    const feed = makeChild("browser-feed", 0, { order });
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);
    await composite.ingest(BATCH);
    expect(order).toEqual(["browser-raw-events", "browser-feed"]);
    expect(raw.ingestArgs).toHaveLength(1);
    expect(feed.ingestArgs).toHaveLength(1);
  });

  it("uses the same scan-envelope ingest lane for historical pages", async () => {
    const order: string[] = [];
    const raw = makeChild("browser-raw-events", 0, { order });
    const feed = makeChild("browser-feed", 0, { order });
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);

    await composite.ingestHistorical(BATCH);

    expect(order).toEqual(["browser-raw-events", "browser-feed"]);
    expect(raw.ingestArgs).toHaveLength(1);
    expect(feed.ingestArgs).toHaveLength(1);
  });

  it("keeps live ephemerals in the agent child and out of persistent children", async () => {
    const raw = makeChild("browser-raw-events", 0);
    const feed = makeChild("browser-feed", 0, { liveAgent: true });
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);
    await composite.ingest({
      events: [{ offset: 1 }, { offset: 2, ephemeral: true }],
      streamMaxOffset: 2,
      scannedAfterOffset: 0,
      scannedThroughOffset: 2,
    } as unknown as Parameters<AnyHostedProcessor["ingest"]>[0]);

    expect(raw.ingestArgs[0]?.events).toEqual([{ offset: 1 }]);
    expect(feed.ingestArgs).toHaveLength(0);
    expect(feed.liveIngestArgs[0]?.events).toEqual([{ offset: 1 }, { offset: 2, ephemeral: true }]);
  });

  it("propagates a later child's ingest failure after the earlier child applied", async () => {
    const order: string[] = [];
    const raw = makeChild("browser-raw-events", 0, { order });
    const feed = makeChild("browser-feed", 0, { order, throwOnIngest: true });
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);
    await expect(composite.ingest(BATCH)).rejects.toThrow(/browser-feed ingest failed/);
    // The primary still ran (and, in the real runtime, checkpointed) before the
    // failure — the runtime self-heals by resubscribing from the new minimum,
    // and the primary skips the replayed events on its own checkpoint filter.
    expect(order).toEqual(["browser-raw-events", "browser-feed"]);
    expect(raw.ingestArgs).toHaveLength(1);
  });

  it("delegates subscriber metrics to the primary (first) child", () => {
    const raw = makeChild("browser-raw-events", 0);
    const feed = makeChild("browser-feed", 0);
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);
    expect(composite.subscriberMetrics.report()).toBe(raw.metrics);
    expect(composite.subscriberMetrics.report()).not.toBe(feed.metrics);
  });

  it("is loaded only when every child is loaded, and marks all children loaded", () => {
    const raw = makeChild("browser-raw-events", 0, { isLoaded: true });
    const feed = makeChild("browser-feed", 0, { isLoaded: false });
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);
    expect(composite.isLoaded).toBe(false);
    composite.markLoaded();
    expect(raw.wasMarkedLoaded()).toBe(true);
    expect(feed.wasMarkedLoaded()).toBe(true);
  });

  it("announces a synthetic mirror contract with the union of members' consumes", () => {
    const raw = makeChild("browser-raw-events", 0);
    const feed = makeChild("browser-feed", 0);
    const composite = new CompositeBrowserProcessor([raw.child, feed.child]);
    expect(composite.contract.slug).toBe("browser-stream-mirror");
    expect(composite.contract.consumes).toEqual(["*"]);
    expect(composite.contract.emits).toEqual([]);
  });
});
