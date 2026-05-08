import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineProcessorContract,
  implementProcessor,
  type ProcessorStreamApi,
  type StreamEvent,
} from "../../stream-processors/stream-processor.ts";
import { wrapProcessorStreamApiWithProvenance } from "./with-stream-processor-runner.ts";

const TestContract = defineProcessorContract({
  slug: "test-runner",
  version: "1.0.0",
  description: "Tests stream processor runner API wrapping.",
  stateSchema: z.object({}).default({}),
  events: {
    "events.iterate.com/test/message": {
      payloadSchema: z.object({ message: z.string() }),
    },
  },
  consumes: ["events.iterate.com/test/message"],
  emits: ["events.iterate.com/test/message"],
});

const TestProcessor = implementProcessor(TestContract, {});

class PrototypeStreamApi implements ProcessorStreamApi<typeof TestContract> {
  appended: StreamEvent[] = [];

  async append(
    args: Parameters<ProcessorStreamApi<typeof TestContract>["append"]>[0],
  ): Promise<StreamEvent> {
    const event = {
      ...args.event,
      streamPath: "/test",
      offset: 2,
      createdAt: "2026-05-05T00:00:00.000Z",
    } as StreamEvent;
    this.appended.push(event);
    return event;
  }

  async appendBatch(
    args: Parameters<NonNullable<ProcessorStreamApi<typeof TestContract>["appendBatch"]>>[0],
  ): Promise<StreamEvent[]> {
    return await Promise.all(args.events.map((event) => this.append({ event })));
  }

  async read(): Promise<StreamEvent[]> {
    return [
      {
        streamPath: "/test",
        type: "events.iterate.com/test/message",
        payload: { message: "read" },
        offset: 1,
        createdAt: "2026-05-05T00:00:00.000Z",
      },
    ];
  }

  async *subscribe(): AsyncIterable<StreamEvent> {
    yield {
      streamPath: "/test",
      type: "events.iterate.com/test/message",
      payload: { message: "subscribed" },
      offset: 3,
      createdAt: "2026-05-05T00:00:00.000Z",
    };
  }
}

describe("wrapProcessorStreamApiWithProvenance", () => {
  it("preserves prototype stream API methods while wrapping append", async () => {
    const baseApi = new PrototypeStreamApi();
    const processingEvent: StreamEvent = {
      streamPath: "/test",
      type: "events.iterate.com/test/message",
      payload: { message: "cause" },
      offset: 1,
      createdAt: "2026-05-05T00:00:00.000Z",
    };

    const wrapped = wrapProcessorStreamApiWithProvenance({
      processingEvent,
      processor: TestProcessor,
      streamApi: baseApi,
    });

    await expect(wrapped.read()).resolves.toHaveLength(1);
    const subscribed: StreamEvent[] = [];
    for await (const event of wrapped.subscribe()) {
      subscribed.push(event);
    }
    expect(subscribed).toHaveLength(1);

    const appended = await wrapped.append({
      event: {
        type: "events.iterate.com/test/message",
        payload: { message: "appended" },
      },
    });

    expect(appended.metadata?.provenance).toEqual({
      processor: {
        slug: "test-runner",
        version: "1.0.0",
      },
      whileProcessingEvent: {
        streamPath: "/test",
        offset: 1,
        type: "events.iterate.com/test/message",
      },
    });
  });
});
