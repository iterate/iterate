import { describe, expect, it } from "vitest";
import type { ProjectRpcTarget, Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import type { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import { CapabilityHostProcessor } from "./capability-host-processor-implementation.ts";

function memoryStream() {
  const events: StreamEvent[] = [];
  return {
    events,
    stream: {
      async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
        const appended = inputs.map((input) => {
          const event: StreamEvent = {
            ...input,
            createdAt: new Date(events.length + 1).toISOString(),
            offset: events.length + 1,
          };
          events.push(event);
          return event;
        });
        return appended;
      },
    } as Stream,
  };
}

function scriptRequested(code: string, executionId: string, offset: number): StreamEvent {
  return {
    createdAt: new Date(offset).toISOString(),
    offset,
    payload: { code, executionId },
    type: "events.iterate.com/capability-host/script-execution-requested",
  };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("CapabilityHostProcessor script execution", () => {
  it("serializes pending script workers from one delivered batch", async () => {
    const { events, stream } = memoryStream();
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let started = 0;
    const dynamicWorkers = {
      async invokeCapability(): Promise<string> {
        const callNumber = ++started;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        return await new Promise<string>((resolve) => {
          releases.push(() => {
            inFlight -= 1;
            resolve(`result-${callNumber}`);
          });
        });
      },
    } as unknown as DynamicWorkerRunner;

    const processor = new CapabilityHostProcessor({
      dynamicWorkers,
      itx: {} as ProjectRpcTarget,
      path: "/agents/web/test",
      stream,
    });

    await processor.ingest({
      events: [
        scriptRequested("async () => 1", "one", 1),
        scriptRequested("async () => 2", "two", 2),
        scriptRequested("async () => 3", "three", 3),
      ],
      streamMaxOffset: 3,
    });

    expect(started).toBe(1);
    expect(maxConcurrent).toBe(1);

    releases.shift()?.();
    await waitUntil(() => started === 2);
    expect(maxConcurrent).toBe(1);

    releases.shift()?.();
    await waitUntil(() => started === 3);
    expect(maxConcurrent).toBe(1);

    releases.shift()?.();
    await waitUntil(
      () =>
        events.filter(
          (event) => event.type === "events.iterate.com/capability-host/script-execution-completed",
        ).length === 3,
    );
    expect(maxConcurrent).toBe(1);
  });
});
