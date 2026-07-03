import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "../../types.ts";
import type { WorkerBuildArtifact, WorkerBuildArtifactStore } from "./artifact-store.ts";
import { WorkerBuildProcessor } from "./worker-build-processor-implementation.ts";

/** Map-backed store: these tests are about the PROCESSOR's lifecycle, not the
 * KV layout (artifact-store.test.ts owns that). */
class InMemoryArtifactStore implements WorkerBuildArtifactStore {
  readonly artifacts = new Map<string, WorkerBuildArtifact>();

  async get(buildKey: string): Promise<WorkerBuildArtifact | null> {
    return this.artifacts.get(buildKey) ?? null;
  }

  async put(artifact: WorkerBuildArtifact): Promise<void> {
    this.artifacts.set(artifact.buildKey, structuredClone(artifact));
  }
}

const artifact: WorkerBuildArtifact = {
  buildKey: "key-1",
  mainModule: "worker.js",
  modules: { "worker.js": "export default {};" },
};

function requestedEvent(input: {
  buildKey: string;
  createdAt?: string;
  offset: number;
}): StreamEvent {
  return {
    createdAt: input.createdAt ?? new Date().toISOString(),
    offset: input.offset,
    payload: {
      buildKey: input.buildKey,
      options: { entryPoint: "worker.js" },
      source: { files: { "worker.js": "export default {};" }, type: "inline" },
    },
    type: "events.iterate.com/worker-build/requested",
  };
}

function harness(overrides: { repoSnapshot?: () => Promise<never> } = {}) {
  const appended: StreamEventInput[] = [];
  const stream = {
    append: async (...events: StreamEventInput[]) => {
      appended.push(...events);
      return events.map((event, index) => ({
        ...event,
        createdAt: new Date().toISOString(),
        offset: 1_000 + appended.length + index,
      }));
    },
  };
  // Capturing keepAliveWhile makes runInBackground work awaitable, so every
  // assertion below is deterministic — including the "nothing else happened"
  // dedupe assertions, which would otherwise be prove-a-negative sleeps.
  const background: Promise<unknown>[] = [];
  const artifactStore = new InMemoryArtifactStore();
  const processor = new WorkerBuildProcessor({
    artifactStore,
    keepAliveWhile: (work) => {
      background.push(work());
    },
    repoSnapshot:
      overrides.repoSnapshot ??
      (() => Promise.reject(new Error("repoSnapshot not expected in this test"))),
    stream: stream as never,
  });
  return {
    appended,
    artifactStore,
    processor,
    settle: () => Promise.allSettled(background),
  };
}

describe("WorkerBuildProcessor", () => {
  it("re-announces completion for a build key already in the artifact store", async () => {
    const { appended, artifactStore, processor, settle } = harness();
    await artifactStore.put(artifact);

    await processor.ingest({
      events: [requestedEvent({ buildKey: "key-1", offset: 1 })],
      streamMaxOffset: 1,
    });
    expect(processor.state.pendingBuilds["key-1"]).toBeDefined();

    await settle();
    expect(appended).toEqual([
      expect.objectContaining({
        payload: { buildKey: "key-1", mainModule: "worker.js", moduleNames: ["worker.js"] },
        type: "events.iterate.com/worker-build/completed",
      }),
    ]);
  });

  it("dedupes a second request while the same build key is pending", async () => {
    const { appended, artifactStore, processor, settle } = harness();
    await artifactStore.put(artifact);

    const now = new Date().toISOString();
    await processor.ingest({
      events: [
        requestedEvent({ buildKey: "key-1", createdAt: now, offset: 1 }),
        requestedEvent({ buildKey: "key-1", createdAt: now, offset: 2 }),
      ],
      streamMaxOffset: 2,
    });

    await settle();
    expect(appended).toHaveLength(1);
  });

  it("treats an old pending entry as dead and retries the build", async () => {
    const { appended, artifactStore, processor, settle } = harness();
    await artifactStore.put(artifact);

    const staleRequestedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await processor.ingest({
      events: [requestedEvent({ buildKey: "key-1", createdAt: staleRequestedAt, offset: 1 })],
      streamMaxOffset: 1,
    });

    // Simulate the first build dying before its terminal event: pendingBuilds
    // still names the key when a later caller re-requests.
    await processor.ingest({
      events: [requestedEvent({ buildKey: "key-1", offset: 2 })],
      streamMaxOffset: 2,
    });
    await settle();
    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/worker-build/completed",
    });
  });

  it("clears pending state when terminal events fold", async () => {
    const { processor, settle } = harness();
    await processor.ingest({
      events: [
        requestedEvent({ buildKey: "key-2", offset: 1 }),
        {
          createdAt: new Date().toISOString(),
          offset: 2,
          payload: { buildKey: "key-2", message: "boom", phase: "bundle" },
          type: "events.iterate.com/worker-build/failed",
        },
      ],
      streamMaxOffset: 2,
    });
    await settle();
    expect(processor.state.pendingBuilds).toEqual({});
  });

  it("appends a failed event with the failing phase when source resolution throws", async () => {
    const { appended, processor, settle } = harness({
      repoSnapshot: () => Promise.reject(new Error("repo unreachable")),
    });

    const event = requestedEvent({ buildKey: "key-3", offset: 1 });
    event.payload = {
      ...event.payload,
      source: { commitOid: "a".repeat(40), repoPath: "/", type: "repo" },
    };
    await processor.ingest({ events: [event], streamMaxOffset: 1 });

    await settle();
    expect(appended).toEqual([
      expect.objectContaining({
        payload: { buildKey: "key-3", message: "repo unreachable", phase: "resolve-source" },
        type: "events.iterate.com/worker-build/failed",
      }),
    ]);
  });
});
