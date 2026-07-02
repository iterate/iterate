import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "../../types.ts";
import { InMemoryWorkerBuildArtifactStore, type WorkerBuildArtifact } from "./artifact-store.ts";
import { WorkerBuildProcessor } from "./worker-build-processor-implementation.ts";

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
      compatibilityDate: "2026-05-01",
      compatibilityFlags: ["nodejs_compat"],
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
  const artifactStore = new InMemoryWorkerBuildArtifactStore();
  const processor = new WorkerBuildProcessor({
    artifactStore,
    repoSnapshot:
      overrides.repoSnapshot ??
      (() => Promise.reject(new Error("repoSnapshot not expected in this test"))),
    stream: stream as never,
  });
  return { appended, artifactStore, processor };
}

async function settle(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("WorkerBuildProcessor", () => {
  it("re-announces completion for a build key already in the artifact store", async () => {
    const { appended, artifactStore, processor } = harness();
    await artifactStore.put(artifact);

    await processor.ingest({
      events: [requestedEvent({ buildKey: "key-1", offset: 1 })],
      streamMaxOffset: 1,
    });
    expect(processor.state.pendingBuilds["key-1"]).toBeDefined();

    await settle(() => appended.length === 1);
    expect(appended[0]).toMatchObject({
      payload: { buildKey: "key-1", mainModule: "worker.js", moduleNames: ["worker.js"] },
      type: "events.iterate.com/worker-build/completed",
    });
  });

  it("dedupes a second request while the same build key is pending", async () => {
    const { appended, artifactStore, processor } = harness();
    await artifactStore.put(artifact);

    const now = new Date().toISOString();
    await processor.ingest({
      events: [
        requestedEvent({ buildKey: "key-1", createdAt: now, offset: 1 }),
        requestedEvent({ buildKey: "key-1", createdAt: now, offset: 2 }),
      ],
      streamMaxOffset: 2,
    });

    await settle(() => appended.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(appended).toHaveLength(1);
  });

  it("treats an old pending entry as dead and retries the build", async () => {
    const { appended, artifactStore, processor } = harness();
    await artifactStore.put(artifact);

    const staleRequestedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await processor.ingest({
      events: [requestedEvent({ buildKey: "key-1", createdAt: staleRequestedAt, offset: 1 })],
      streamMaxOffset: 1,
    });
    await settle(() => appended.length === 1);

    // Simulate the first build dying before its terminal event: pendingBuilds
    // still names the key when a later caller re-requests.
    await processor.ingest({
      events: [requestedEvent({ buildKey: "key-1", offset: 2 })],
      streamMaxOffset: 2,
    });
    await settle(() => appended.length === 2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/worker-build/completed",
    });
  });

  it("clears pending state when terminal events fold", async () => {
    const { processor } = harness();
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
    expect(processor.state.pendingBuilds).toEqual({});
  });

  it("appends a failed event with the failing phase when source resolution throws", async () => {
    const { appended, processor } = harness({
      repoSnapshot: () => Promise.reject(new Error("repo unreachable")),
    });

    const event = requestedEvent({ buildKey: "key-3", offset: 1 });
    event.payload = {
      ...event.payload,
      source: { commitOid: "a".repeat(40), repoPath: "/", type: "repo" },
    };
    await processor.ingest({ events: [event], streamMaxOffset: 1 });

    await settle(() => appended.length === 1);
    expect(appended[0]).toMatchObject({
      payload: { buildKey: "key-3", message: "repo unreachable", phase: "resolve-source" },
      type: "events.iterate.com/worker-build/failed",
    });
  });
});
