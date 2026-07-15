import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import type { StreamPushEventBatch } from "../streams/rpc-types.ts";

const { mockItxEnv } = vi.hoisted(() => ({
  mockItxEnv: {} as { SEARCH_BUCKET: R2Bucket },
}));
vi.mock("../../env.ts", () => ({ itxEnv: mockItxEnv }));

import {
  StreamSegmentIndexCoalescer,
  type StreamIndexBucket,
  type StreamSegmentIndexRequest,
  indexStreamEventBatch,
} from "./search-index.ts";

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function event(offset: number, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    type: "events.iterate.com/agent/message-received",
    createdAt: "2026-07-15T00:00:00.000Z",
    path: "/agents/test",
    payload: { offset },
    offset,
    ...overrides,
  };
}

interface StoredObject {
  body: string;
  customMetadata?: Record<string, string>;
  etag: string;
}

interface PutCall {
  key: string;
  options: R2PutOptions & { onlyIf: R2Conditional };
  value: string;
}

class ConditionalBucket implements StreamIndexBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly putCalls: PutCall[] = [];
  activePuts = 0;
  beforePut?: (call: PutCall) => Promise<void>;
  maxActivePuts = 0;
  #etag = 0;

  async head(key: string): Promise<Pick<R2Object, "customMetadata" | "etag"> | null> {
    const object = this.objects.get(key);
    return object === undefined
      ? null
      : { customMetadata: object.customMetadata, etag: object.etag };
  }

  async put(
    key: string,
    value: string,
    options: R2PutOptions & { onlyIf: R2Conditional },
  ): Promise<Pick<R2Object, "customMetadata" | "etag"> | null> {
    const call = { key, options, value };
    this.putCalls.push(call);
    this.activePuts += 1;
    this.maxActivePuts = Math.max(this.maxActivePuts, this.activePuts);
    try {
      await this.beforePut?.(call);
      const current = this.objects.get(key);
      if (
        (options.onlyIf.etagMatches !== undefined &&
          current?.etag !== options.onlyIf.etagMatches) ||
        (options.onlyIf.etagDoesNotMatch === "*" && current !== undefined)
      ) {
        return null;
      }
      const object = {
        body: value,
        customMetadata: options.customMetadata,
        etag: `etag-${++this.#etag}`,
      };
      this.objects.set(key, object);
      return object;
    } finally {
      this.activePuts -= 1;
    }
  }
}

function request(input: {
  loadEvents: () => Promise<StreamEvent[]>;
  offset: number;
  path?: string;
  projectId?: string;
}): StreamSegmentIndexRequest {
  return {
    loadEvents: input.loadEvents,
    path: input.path ?? "/agents/test",
    projectId: input.projectId ?? "prj_test",
    segment: 0,
    throughOffset: input.offset,
  };
}

function batch(offset: number): StreamPushEventBatch {
  const streamEvent = event(offset);
  return {
    attempt: 1,
    configuredEvent: {
      ...event(1),
      type: "events.iterate.com/stream/subscription-configured",
    },
    deliveryId: `project-worker:${offset}-${offset}`,
    events: [streamEvent],
    path: streamEvent.path,
    projectId: "prj_test",
    streamMaxOffset: offset,
    subscriptionKey: "project-worker",
  };
}

function coalescer(bucket: ConditionalBucket): StreamSegmentIndexCoalescer {
  return new StreamSegmentIndexCoalescer({
    bucket: () => bucket,
    paceSameKeyWrite: () => Promise.resolve(),
  });
}

describe("StreamSegmentIndexCoalescer", () => {
  it("collapses eight same-key racing batches into one active and one trailing rewrite", async () => {
    const bucket = new ConditionalBucket();
    mockItxEnv.SEARCH_BUCKET = bucket as unknown as R2Bucket;
    vi.stubGlobal("scheduler", { wait: () => Promise.resolve() });
    const firstRead = deferred<StreamEvent[]>();
    let readCalls = 0;
    const first = indexStreamEventBatch({
      batch: batch(1),
      readEvents: () => {
        readCalls += 1;
        return firstRead.promise;
      },
    });
    await vi.waitFor(() => expect(readCalls).toBe(1));

    const trailing = Array.from({ length: 7 }, (_, indexOffset) => {
      const offset = indexOffset + 2;
      return indexStreamEventBatch({
        batch: batch(offset),
        readEvents: async () => {
          readCalls += 1;
          return Array.from({ length: offset }, (_, eventOffset) => event(eventOffset + 1));
        },
      });
    });
    firstRead.resolve([event(1)]);
    await Promise.all([first, ...trailing]);

    expect(readCalls).toBe(2);
    expect(bucket.putCalls).toHaveLength(2);
    expect(bucket.maxActivePuts).toBe(1);
    const stored = [...bucket.objects.values()][0]!;
    expect(stored.customMetadata?.streamThroughOffset).toBe("8");
    expect(stored.body).toContain("offset 8");
  });

  it("runs distinct segment keys in parallel", async () => {
    const bucket = new ConditionalBucket();
    const index = coalescer(bucket);
    const releaseReads = deferred<void>();
    const bothStarted = deferred<void>();
    let activeReads = 0;
    let maxActiveReads = 0;
    const load = (path: string) => async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      if (activeReads === 2) bothStarted.resolve();
      await releaseReads.promise;
      activeReads -= 1;
      return [event(1, { path })];
    };

    const one = index.index(request({ loadEvents: load("/one"), offset: 1, path: "/one" }));
    const two = index.index(request({ loadEvents: load("/two"), offset: 1, path: "/two" }));
    await bothStarted.promise;
    expect(maxActiveReads).toBe(2);
    releaseReads.resolve();
    await Promise.all([one, two]);

    expect(bucket.objects.size).toBe(2);
  });

  it("uses conditional puts so an older cross-isolate completion cannot replace newer data", async () => {
    const bucket = new ConditionalBucket();
    const olderPut = deferred<void>();
    const newerPut = deferred<void>();
    const olderStarted = deferred<void>();
    const newerStarted = deferred<void>();
    bucket.beforePut = async (call) => {
      if (call.options.customMetadata?.streamThroughOffset === "1") {
        olderStarted.resolve();
        await olderPut.promise;
      } else {
        newerStarted.resolve();
        await newerPut.promise;
      }
    };
    const olderIsolate = coalescer(bucket);
    const newerIsolate = coalescer(bucket);

    const older = olderIsolate.index(request({ loadEvents: async () => [event(1)], offset: 1 }));
    await olderStarted.promise;
    const newer = newerIsolate.index(
      request({
        loadEvents: async () => Array.from({ length: 8 }, (_, offset) => event(offset + 1)),
        offset: 8,
      }),
    );
    await newerStarted.promise;
    newerPut.resolve();
    await newer;
    olderPut.resolve();
    await older;

    expect(bucket.putCalls).toHaveLength(2);
    const stored = [...bucket.objects.values()][0]!;
    expect(stored.customMetadata?.streamThroughOffset).toBe("8");
    expect(stored.body).toContain("offset 8");
  });

  it("leaves a concurrently-created append-only segment intact after a null render", async () => {
    const bucket = new ConditionalBucket();
    const nullRead = deferred<StreamEvent[]>();
    const nullIsolate = coalescer(bucket);
    const writerIsolate = coalescer(bucket);
    const nullIndex = nullIsolate.index(request({ loadEvents: () => nullRead.promise, offset: 1 }));
    await Promise.resolve();

    await writerIsolate.index(request({ loadEvents: async () => [event(1), event(2)], offset: 2 }));
    nullRead.resolve([event(1, { type: "events.iterate.com/stream/woken" })]);
    await nullIndex;

    expect(bucket.putCalls).toHaveLength(1);
    const stored = [...bucket.objects.values()][0]!;
    expect(stored.customMetadata?.streamThroughOffset).toBe("2");
    expect(stored.body).toContain("offset 2");
  });

  it("paces and retries R2 same-key rate limits", async () => {
    const bucket = new ConditionalBucket();
    let attempts = 0;
    bucket.beforePut = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Reduce your concurrent request rate for the same object"), {
          code: 10_058,
        });
      }
    };
    let paces = 0;
    const index = new StreamSegmentIndexCoalescer({
      bucket: () => bucket,
      paceSameKeyWrite: async () => {
        paces += 1;
      },
    });

    await index.index(request({ loadEvents: async () => [event(1)], offset: 1 }));
    expect(bucket.putCalls).toHaveLength(2);
    expect(paces).toBe(1);
    expect(bucket.objects.size).toBe(1);
  });

  it("removes failed entries so a later mark can retry the same key", async () => {
    const bucket = new ConditionalBucket();
    const index = coalescer(bucket);
    await expect(
      index.index(
        request({
          loadEvents: async () => {
            throw new Error("read failed");
          },
          offset: 1,
        }),
      ),
    ).rejects.toThrow("read failed");

    await index.index(request({ loadEvents: async () => [event(1)], offset: 1 }));
    expect(bucket.putCalls).toHaveLength(1);
    expect(bucket.objects.size).toBe(1);
  });
});
